import type { CollectionSlug, Config, Field, Payload, Plugin } from 'payload';

// ─── Types ────────────────────────────────────────────────────────────────────

// A populate tree describes which relations to populate, recursively.
//   true                       → populate this relation (leaf, no deeper)
//   { avatar: true }           → populate this relation, then populate `avatar`
//                                on the fetched related docs (cross-collection)
// The whole query/default is a `PopulateTree` at the collection root.
export type PopulateTree = { [field: string]: true | PopulateTree };

// Collections opt-in via Payload's official `custom` extension point:
//   custom: { defaultPopulateOnly: 'none' }                    // populate nothing
//   custom: { defaultPopulateOnly: { avatar: true } }          // one relation
//   custom: { defaultPopulateOnly: { owner: { avatar: true } } } // nested
// The `populateOnly` query param fully replaces this default. `'none'` is the
// only accepted string form (populate nothing); everything else is a tree.
// Payload's `CollectionCustom` is an augmentable interface, so consumers keep
// using plain `CollectionConfig` with full type-checking — no import needed.
declare module 'payload' {
  interface CollectionCustom {
    defaultPopulateOnly?: PopulateTree | 'none';
  }
}

interface RelationshipFieldInfo {
  path: string;
  relationTo: string | string[];
  hasMany: boolean;
  type: 'relationship' | 'upload';
}

interface SelectivePopulateContext {
  tree: PopulateTree;
  overrideAccess: boolean;
}

// ─── Field Walker ─────────────────────────────────────────────────────────────

function getRelationshipFields(fields: Field[], parentPath = ''): RelationshipFieldInfo[] {
  const result: RelationshipFieldInfo[] = [];

  for (const field of fields) {
    if (field.type === 'relationship' || field.type === 'upload') {
      const path = parentPath ? `${parentPath}.${field.name}` : field.name;
      result.push({
        path,
        relationTo: field.relationTo,
        hasMany: field.type === 'relationship' && field.hasMany === true,
        type: field.type,
      });
    }

    if (field.type === 'group' && 'name' in field && field.name) {
      const prefix = parentPath ? `${parentPath}.${field.name}` : field.name;
      result.push(...getRelationshipFields(field.fields, prefix));
    } else if (field.type === 'group') {
      result.push(...getRelationshipFields(field.fields, parentPath));
    }

    if (field.type === 'array') {
      const prefix = parentPath ? `${parentPath}.${field.name}` : field.name;
      result.push(...getRelationshipFields(field.fields, prefix));
    }

    if (field.type === 'blocks') {
      for (const block of field.blocks) {
        if (typeof block !== 'string') {
          const prefix = parentPath ? `${parentPath}.${field.name}` : field.name;
          result.push(...getRelationshipFields(block.fields, prefix));
        }
      }
    }
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        const prefix =
          'name' in tab && tab.name
            ? parentPath
              ? `${parentPath}.${tab.name}`
              : tab.name
            : parentPath;
        result.push(...getRelationshipFields(tab.fields, prefix));
      }
    }

    if (field.type === 'row' || field.type === 'collapsible') {
      result.push(...getRelationshipFields(field.fields, parentPath));
    }
  }

  return result;
}

// ─── Value Helpers ────────────────────────────────────────────────────────────

function extractId(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object' && 'id' in value) return (value as { id: string | number }).id;
  return null;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (current[seg] == null || typeof current[seg] !== 'object') return;
    current = current[seg] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

// ─── Population Logic ─────────────────────────────────────────────────────────

// Build an isolated request for nested populate finds: same user/transaction,
// but a context AND query both forced to `populateOnly: 'none'`, so the plugin's
// own REST hooks no-op on the nested find. The beforeOperation guard bails as
// soon as `paramName in req.context`, so setting it here (not relying on
// Payload's context merge) is what stops the hook from RE-ARMING off the target
// collection's own `defaultPopulateOnly` — recursion is driven solely by
// populateFields, never by a nested find re-entering the plugin.
function makeInternalReq(req: any, paramName: string): any {
  const { [paramName]: _stripped, ...restQuery } = (req?.query ?? {}) as Record<string, unknown>;
  return {
    ...req,
    context: { [paramName]: 'none' },
    query: { ...restQuery, [paramName]: 'none' },
  };
}

// Hard cap on how deep a populate tree may recurse. Guards against malformed
// trees or relation cycles (A → B → A) exploding into unbounded fetch chains.
const MAX_TREE_DEPTH = 6;

// Resolve a field's subtree from the populate tree. A field is populated when
// its name (last path segment, e.g. "avatar" from "group.avatar") or its full
// path is a key in the tree. Returns the subtree (`true` = leaf, object =
// recurse into the related docs), or null when the field is not requested.
function resolveFieldNode(
  field: RelationshipFieldInfo,
  tree: PopulateTree,
): true | PopulateTree | null {
  const fieldName = field.path.includes('.') ? field.path.split('.').pop()! : field.path;
  const node = tree[field.path] ?? tree[fieldName];
  return node ?? null;
}

// A single relation field that the tree asked to populate, resolved against the
// collection's schema, with its child subtree (null = leaf, no recursion).
interface RequestedField {
  field: RelationshipFieldInfo;
  childTree: PopulateTree | null;
}

// Warn once per unmatched tree key so typos (e.g. `{ avatr: true }`) surface in
// logs instead of silently yielding an un-populated relation. `disableErrors`
// only silences access failures on real fetches, not schema typos.
function warnUnmatchedKeys(tree: PopulateTree, fields: RelationshipFieldInfo[]): void {
  const known = new Set<string>();
  for (const f of fields) {
    known.add(f.path);
    known.add(f.path.includes('.') ? f.path.split('.').pop()! : f.path);
  }
  for (const key of Object.keys(tree)) {
    if (!known.has(key)) {
      console.warn(
        `[selectivePopulate] populate key "${key}" matches no relationship field — ignored (typo?)`,
      );
    }
  }
}

// Populate every requested relation of `docs` in one level, then recurse.
//
// Perf: fetches are batched by TARGET COLLECTION across ALL requested fields of
// the level (not per field). So on a game, `owner` and `players` (both → users)
// share a single `users` find, and their nested `avatar` (both → media
// instances) share a single media-instances find. Deduped ids, one find per
// collection per level.
async function populateFields(
  docs: Record<string, unknown>[],
  fields: RelationshipFieldInfo[],
  tree: PopulateTree,
  payload: Payload,
  overrideAccess: boolean,
  disableErrors: boolean,
  bypassAccessFor: Set<string>,
  collections: Record<string, { config: { fields: Field[] } }>,
  remainingDepth: number,
  // The plugin's populate param name, forced to 'none' on every nested find so
  // neither arming path re-enters the plugin: the Local API wrapper reads
  // `options.context[paramName]` and the REST hook reads `req.query[paramName]`.
  // Setting BOTH to 'none' short-circuits the fallback onto the target
  // collection's own `defaultPopulateOnly`. This function alone drives the
  // depth traversal; nested finds never re-populate.
  paramName: string,
  // The originating request (same user / transaction), reused for nested finds
  // via makeInternalReq. Isolation alone is NOT enough — see paramName above.
  req?: unknown,
): Promise<void> {
  if (remainingDepth <= 0) return;

  warnUnmatchedKeys(tree, fields);

  // Resolve which schema fields the tree asked for.
  const requested: RequestedField[] = [];
  for (const field of fields) {
    const node = resolveFieldNode(field, tree);
    if (node === null) continue;
    requested.push({ field, childTree: node === true ? null : node });
  }
  if (requested.length === 0) return;

  // Collect ids per target collection ACROSS all requested fields (dedup), and
  // remember which child subtrees target each collection (for the recursion).
  const idsByCollection = new Map<string, Set<string>>();
  const childTreesByCollection = new Map<string, PopulateTree[]>();

  for (const { field, childTree } of requested) {
    const isPolymorphic = Array.isArray(field.relationTo);
    for (const doc of docs) {
      if (field.path.includes('.') && isArrayPath(doc, field.path)) {
        for (const item of getArrayItems(doc, field.path)) {
          collectIdsFromValue(item.value, field, isPolymorphic, idsByCollection);
        }
      } else {
        collectIdsFromValue(getNestedValue(doc, field.path), field, isPolymorphic, idsByCollection);
      }
    }
    if (childTree) {
      for (const slug of relationSlugs(field)) {
        const list = childTreesByCollection.get(slug) ?? [];
        list.push(childTree);
        childTreesByCollection.set(slug, list);
      }
    }
  }

  // One find per target collection, then recurse once on all its fetched docs.
  const docMaps = new Map<string, Map<string | number, Record<string, unknown>>>();

  await Promise.all(
    [...idsByCollection.entries()].map(async ([collectionSlug, ids]) => {
      if (ids.size === 0) return;

      try {
        const effectiveOverrideAccess = overrideAccess || bypassAccessFor.has(collectionSlug);
        // Batched fetch for this target collection. Forcing `populateOnly: 'none'`
        // on BOTH the Local API context and the isolated req.query stops the
        // patched find / REST hooks from re-arming off this collection's own
        // `defaultPopulateOnly`; recursion is driven by populateFields alone.
        const result = await payload.find({
          collection: collectionSlug as CollectionSlug,
          where: { id: { in: [...ids] } },
          depth: 0,
          limit: 0,
          pagination: false,
          overrideAccess: effectiveOverrideAccess,
          disableErrors,
          context: { [paramName]: 'none' },
          ...(req ? { req: makeInternalReq(req, paramName) as never } : {}),
        });

        const fetchedDocs = result.docs as unknown as Record<string, unknown>[];

        // Deep populate: merge all child subtrees pointing at this collection
        // and recurse once over every fetched doc.
        const childTrees = childTreesByCollection.get(collectionSlug);
        if (childTrees && fetchedDocs.length > 0) {
          const relatedFields = collections[collectionSlug]?.config?.fields;
          if (relatedFields) {
            await populateFields(
              fetchedDocs,
              getRelationshipFields(relatedFields),
              mergeTrees(childTrees),
              payload,
              overrideAccess,
              disableErrors,
              bypassAccessFor,
              collections,
              remainingDepth - 1,
              paramName,
              req,
            );
          }
        }

        const map = new Map<string | number, Record<string, unknown>>();
        for (const fetchedDoc of fetchedDocs) {
          map.set(fetchedDoc.id as string | number, fetchedDoc);
        }
        docMaps.set(collectionSlug, map);
      } catch (err) {
        if (!disableErrors) {
          console.warn(
            `[selectivePopulate] nested find on "${collectionSlug}" failed:`,
            err instanceof Error ? err.message : err,
          );
        }
        // Access denied or error — leave IDs as-is
      }
    }),
  );

  // Replace ids with the populated docs, per requested field.
  for (const { field } of requested) {
    const isPolymorphic = Array.isArray(field.relationTo);
    for (const doc of docs) {
      if (field.path.includes('.') && isArrayPath(doc, field.path)) {
        replaceInArrayPath(doc, field, isPolymorphic, docMaps);
      } else {
        const value = getNestedValue(doc, field.path);
        const replaced = replaceValue(value, field, isPolymorphic, docMaps);
        if (replaced !== undefined) {
          setNestedValue(doc, field.path, replaced);
        }
      }
    }
  }
}

// Target collection slug(s) of a relation field (single or polymorphic).
function relationSlugs(field: RelationshipFieldInfo): string[] {
  return Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo];
}

// Shallow-merge several populate subtrees into one. Two fields targeting the
// same collection (e.g. owner + players → users) may request different nested
// relations; the union is populated. `true` (leaf) and an object merge to the
// object so the deeper request wins.
function mergeTrees(trees: PopulateTree[]): PopulateTree {
  if (trees.length === 1) return trees[0]!;
  const merged: PopulateTree = {};
  for (const tree of trees) {
    for (const [key, value] of Object.entries(tree)) {
      const existing = merged[key];
      if (existing === undefined || existing === true) {
        merged[key] = value;
      } else if (value !== true) {
        merged[key] = mergeTrees([existing, value]);
      }
    }
  }
  return merged;
}

function collectIdsFromValue(
  value: unknown,
  field: RelationshipFieldInfo,
  isPolymorphic: boolean,
  idsByCollection: Map<string, Set<string>>,
): void {
  if (value == null) return;

  if (field.hasMany && Array.isArray(value)) {
    for (const item of value) {
      collectIdsFromValue(item, { ...field, hasMany: false }, isPolymorphic, idsByCollection);
    }
    return;
  }

  if (isPolymorphic) {
    const poly = value as { relationTo?: string; value?: unknown };
    if (poly.relationTo) {
      const id = extractId(poly.value);
      if (id != null) {
        if (!idsByCollection.has(poly.relationTo)) idsByCollection.set(poly.relationTo, new Set());
        idsByCollection.get(poly.relationTo)!.add(String(id));
      }
    }
  } else {
    const slug = field.relationTo as string;
    const id = extractId(value);
    if (id != null) {
      if (!idsByCollection.has(slug)) idsByCollection.set(slug, new Set());
      idsByCollection.get(slug)!.add(String(id));
    }
  }
}

function replaceValue(
  value: unknown,
  field: RelationshipFieldInfo,
  isPolymorphic: boolean,
  docMaps: Map<string, Map<string | number, Record<string, unknown>>>,
): unknown {
  if (value == null) return undefined;

  if (field.hasMany && Array.isArray(value)) {
    return value.map(
      (item) => replaceValue(item, { ...field, hasMany: false }, isPolymorphic, docMaps) ?? item,
    );
  }

  if (isPolymorphic) {
    const poly = value as { relationTo?: string; value?: unknown };
    if (poly.relationTo) {
      const id = extractId(poly.value);
      const map = docMaps.get(poly.relationTo);
      if (id != null && map?.has(String(id))) {
        return { ...poly, value: map.get(String(id)) };
      }
    }
    return undefined;
  }

  const slug = field.relationTo as string;
  const id = extractId(value);
  const map = docMaps.get(slug);
  if (id != null && map?.has(String(id))) {
    return map.get(String(id));
  }
  return undefined;
}

// ─── Array Path Helpers ───────────────────────────────────────────────────────

function isArrayPath(doc: Record<string, unknown>, path: string): boolean {
  const segments = path.split('.');
  let current: unknown = doc;
  for (const seg of segments) {
    if (current == null) return false;
    if (Array.isArray(current)) return true;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return false;
    }
  }
  return false;
}

function getArrayItems(
  doc: Record<string, unknown>,
  path: string,
): { parent: unknown; key: string; value: unknown }[] {
  const segments = path.split('.');
  const results: { parent: unknown; key: string; value: unknown }[] = [];

  function walk(current: unknown, segIndex: number): void {
    if (segIndex >= segments.length) return;
    const seg = segments[segIndex];

    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item, segIndex);
      }
      return;
    }

    if (current == null || typeof current !== 'object') return;
    const obj = current as Record<string, unknown>;

    if (segIndex === segments.length - 1) {
      results.push({ parent: obj, key: seg, value: obj[seg] });
    } else {
      walk(obj[seg], segIndex + 1);
    }
  }

  walk(doc, 0);
  return results;
}

function replaceInArrayPath(
  doc: Record<string, unknown>,
  field: RelationshipFieldInfo,
  isPolymorphic: boolean,
  docMaps: Map<string, Map<string | number, Record<string, unknown>>>,
): void {
  const items = getArrayItems(doc, field.path);
  for (const item of items) {
    const replaced = replaceValue(item.value, field, isPolymorphic, docMaps);
    if (replaced !== undefined) {
      (item.parent as Record<string, unknown>)[item.key] = replaced;
    }
  }
}

// ─── Parse populateOnly param ─────────────────────────────────────────────────

// Normalize any raw `populateOnly` / `defaultPopulateOnly` value to a
// PopulateTree, or null to signal "not provided, fall back".
//   - 'none'            → {} (plugin active, populate nothing)
//   - PopulateTree obj  → the tree (leaf values coerced to `true`)
//   - undefined / null  → null (fall back to the collection default)
// Query params arrive via qs.parse, so nested leaves are the STRING "true"
// (e.g. { owner: { avatar: "true" } }); we coerce them here. A leaf that is
// literally the string "false" (or "0") is dropped — treated as not requested.
function normalizePopulateTree(raw: unknown): PopulateTree | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    return raw.trim().toLowerCase() === 'none' ? {} : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const tree: PopulateTree = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true) {
      tree[key] = true;
    } else if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true' || v === '1') tree[key] = true;
      // "false"/"0"/anything else → field not requested, skip
    } else if (value && typeof value === 'object') {
      const child = normalizePopulateTree(value);
      if (child) tree[key] = child;
    }
  }
  return tree;
}

// Resolve the effective tree: an explicit query value wins over the default.
function resolvePopulateTree(queryValue: unknown, defaults: unknown): PopulateTree | null {
  const fromQuery = normalizePopulateTree(queryValue);
  if (fromQuery !== null) return fromQuery;
  return normalizePopulateTree(defaults);
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const CONTEXT_KEY = '_selectivePopulate';

export const selectivePopulate = (options?: {
  paramName?: string;
  disableErrors?: boolean;
  // ⚠️ SECURITY DECISION — read carefully before adding a slug here.
  //
  // Collections listed here are fetched with `overrideAccess: true` during
  // population, i.e. their read access control is BYPASSED. This exists for
  // owner-gated media (`librarian-media-instances`): media are private on a
  // direct find, but must be readable when reached through a relation the
  // requester is already authorized to see (a game thumbnail, a player's
  // avatar, an image in a chat…). Payload's native populate would re-enforce
  // owner-only access and drop them, so we bypass here.
  //
  // The safety assumption is: "if you could read the PARENT doc holding this
  // relation, you may read the related media". It is NOT membership-scoped —
  // the bypass is unconditional once the collection is reached via populate.
  // Therefore only add a slug whose docs are safe to expose to anyone able to
  // reach them through ANY relation. Never add a collection that carries data
  // more sensitive than its every possible parent's read access implies.
  bypassAccessFor?: CollectionSlug[];
}): Plugin => {
  const paramName = options?.paramName || 'populateOnly';
  const disableErrors = options?.disableErrors ?? true;
  const bypassAccessFor = new Set<string>(options?.bypassAccessFor ?? []);

  return (config: Config): Config => {
    const existingOnInit = config.onInit;

    // ── onInit: wrap Local API (payload.find / payload.findByID) ──────────
    config.onInit = async (payload: Payload) => {
      if (existingOnInit) await existingOnInit(payload);

      const collections = payload.collections as Record<
        string,
        { config: { fields: Field[]; custom?: { defaultPopulateOnly?: unknown } } }
      >;

      // Wrap payload.find for Local API usage
      const originalFind = payload.find.bind(payload);
      (payload as any).find = async (findOptions: any) => {
        const collection = collections[findOptions.collection];
        const spContext = getLocalApiContext(
          findOptions,
          paramName,
          collection?.config?.custom?.defaultPopulateOnly,
        );
        if (!spContext) {
          return originalFind(findOptions);
        }

        const result = await originalFind({ ...findOptions, depth: 0 });

        if (!collection?.config?.fields) return result;
        if (Object.keys(spContext.tree).length === 0) return result;

        const relationFields = getRelationshipFields(collection.config.fields);
        const docs = result.docs as unknown as Record<string, unknown>[];
        await populateFields(
          docs,
          relationFields,
          spContext.tree,
          payload,
          spContext.overrideAccess,
          disableErrors,
          bypassAccessFor,
          collections,
          MAX_TREE_DEPTH,
          paramName,
          findOptions.req,
        );

        return result;
      };

      // Wrap payload.findByID for Local API usage
      const originalFindByID = payload.findByID.bind(payload);
      (payload as any).findByID = async (opts: any) => {
        const collection = collections[opts.collection];
        const spContext = getLocalApiContext(
          opts,
          paramName,
          collection?.config?.custom?.defaultPopulateOnly,
        );
        if (!spContext) {
          return originalFindByID(opts);
        }

        const doc = await originalFindByID({ ...opts, depth: 0 });

        if (!collection?.config?.fields) return doc;
        if (Object.keys(spContext.tree).length === 0) return doc;

        const relationFields = getRelationshipFields(collection.config.fields);
        const docs = [doc as unknown as Record<string, unknown>];
        await populateFields(
          docs,
          relationFields,
          spContext.tree,
          payload,
          spContext.overrideAccess,
          disableErrors,
          bypassAccessFor,
          collections,
          MAX_TREE_DEPTH,
          paramName,
          opts.req,
        );

        return doc;
      };
    };

    // ── Collection hooks: intercept REST API requests ─────────────────────
    if (config.collections) {
      config.collections = config.collections.map((collection) => ({
        ...collection,
        hooks: {
          ...collection.hooks,

          // beforeOperation: plugin runs FIRST (captures depth before user hooks)
          beforeOperation: [
            ({ args, collection: runtimeCollection, operation }: any) => {
              if (operation !== 'read') return args;

              const req = args.req;

              // Whenever the value travels in req.context, the Local API owns
              // this read: the wrapper (payload.find / findByID) already resolved
              // the tree and will populate. This hook must NOT arm too — reading
              // req.context here (a real tree OR an explicit 'none') would either
              // double-populate the Local API read or re-arm the nested find off
              // the TARGET collection's own default (the re-entrance bug). Bail as
              // soon as the key is present in context, regardless of its value.
              if (req?.context && paramName in req.context) {
                return args;
              }

              // REST arms from the query param only.
              const rawParam = req?.query?.[paramName];
              // Read defaults via the official `custom` extension point. In a
              // hook, `runtimeCollection` IS the sanitized config (Payload passes
              // `collection.config` directly), so custom lives at
              // `runtimeCollection.custom` — NOT `.config.custom`. We fall back to
              // the payload registry, then the pre-sanitize closure.
              const slug = runtimeCollection?.slug ?? collection.slug;
              const defaults =
                (runtimeCollection?.custom as { defaultPopulateOnly?: unknown } | undefined)
                  ?.defaultPopulateOnly ??
                (
                  req?.payload?.collections?.[slug]?.config?.custom as
                    | { defaultPopulateOnly?: unknown }
                    | undefined
                )?.defaultPopulateOnly ??
                (collection.custom as { defaultPopulateOnly?: unknown } | undefined)
                  ?.defaultPopulateOnly;
              const tree = resolvePopulateTree(rawParam, defaults);
              if (tree === null) return args;

              // Store in req.context for afterOperation
              if (req?.context) {
                req.context[CONTEXT_KEY] = {
                  tree,
                  overrideAccess: args.overrideAccess ?? false,
                } satisfies SelectivePopulateContext;
              }

              // Set depth to 0 to prevent Payload from populating anything
              return { ...args, depth: 0 };
            },
            ...(collection.hooks?.beforeOperation || []),
          ],

          // afterOperation: re-populate only the requested relations
          afterOperation: [
            ...(collection.hooks?.afterOperation || []),
            async ({ args, operation, result }: any) => {
              if (operation !== 'find' && operation !== 'findByID') return result;

              const req = args?.req;
              const spContext = req?.context?.[CONTEXT_KEY] as SelectivePopulateContext | undefined;
              if (!spContext) {
                return result;
              }

              // Consume the context so this read doesn't re-populate again.
              // Re-entrancy is prevented at the source: the cascade's nested
              // finds use an isolated request (makeInternalReq) that never
              // re-arms the plugin — no per-request flag needed here.
              delete req.context[CONTEXT_KEY];

              // `none` path: context set, but no field should be populated.
              if (Object.keys(spContext.tree).length === 0) {
                return result;
              }

              const payload = req.payload as Payload;
              const collectionSlug = args.collection?.config?.slug || args.collection?.slug;
              const collections = payload.collections as Record<
                string,
                { config: { fields: Field[] } }
              >;
              const col = collections[collectionSlug];
              if (!col?.config?.fields) return result;

              const relationFields = getRelationshipFields(col.config.fields);

              if (operation === 'find' && result?.docs) {
                const docs = result.docs as unknown as Record<string, unknown>[];
                await populateFields(
                  docs,
                  relationFields,
                  spContext.tree,
                  payload,
                  spContext.overrideAccess,
                  disableErrors,
                  bypassAccessFor,
                  collections,
                  MAX_TREE_DEPTH,
                  paramName,
                  req,
                );
              } else if (operation === 'findByID' && result) {
                const docs = [result as unknown as Record<string, unknown>];
                await populateFields(
                  docs,
                  relationFields,
                  spContext.tree,
                  payload,
                  spContext.overrideAccess,
                  disableErrors,
                  bypassAccessFor,
                  collections,
                  MAX_TREE_DEPTH,
                  paramName,
                  req,
                );
              }

              return result;
            },
          ],
        },
      })) as typeof config.collections;
    }

    return config;
  };
};

// ─── Context Helpers ──────────────────────────────────────────────────────────

function getLocalApiContext(
  options: { context?: Record<string, unknown>; depth?: number; overrideAccess?: boolean },
  paramName: string,
  defaults: unknown,
): SelectivePopulateContext | null {
  const ctx = options.context as Record<string, unknown> | undefined;
  const raw = ctx?.[paramName];

  // Local API passes the value as a plain JS object (a PopulateTree) or the
  // 'none' string through `context.populateOnly`; absent → fall back to default.
  const tree = resolvePopulateTree(raw, defaults);
  if (tree === null) return null;

  // Default to enforcing access on populated relations (fail closed). Only the
  // collections in `bypassAccessFor` escape it. A caller that wants a blanket
  // bypass must pass `overrideAccess: true` explicitly — we do NOT inherit
  // Payload's Local API default (true) here, because this flag governs OTHER
  // collections reached through populate, not just the one being read.
  return {
    tree,
    overrideAccess: options.overrideAccess ?? false,
  };
}
