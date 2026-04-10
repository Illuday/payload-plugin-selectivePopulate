import type { CollectionSlug, Config, Field, Payload, Plugin } from 'payload';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RelationshipFieldInfo {
  path: string;
  relationTo: string | string[];
  hasMany: boolean;
  type: 'relationship' | 'upload';
}

interface SelectivePopulateContext {
  originalDepth: number;
  allowedFields: Set<string>;
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

function shouldPopulateField(field: RelationshipFieldInfo, allowedFields: Set<string>): boolean {
  // Match by field name (last segment of path, e.g. "avatar" from "group.avatar")
  const fieldName = field.path.includes('.') ? field.path.split('.').pop()! : field.path;
  return allowedFields.has(fieldName) || allowedFields.has(field.path);
}

async function populateFields(
  docs: Record<string, unknown>[],
  fields: RelationshipFieldInfo[],
  allowedFields: Set<string>,
  payload: Payload,
  depth: number,
  overrideAccess: boolean,
  req?: unknown,
): Promise<void> {
  const fieldsToPopulate = fields.filter((f) => shouldPopulateField(f, allowedFields));

  await Promise.all(
    fieldsToPopulate.map((field) =>
      populateField(docs, field, payload, depth, overrideAccess, req),
    ),
  );
}

async function populateField(
  docs: Record<string, unknown>[],
  field: RelationshipFieldInfo,
  payload: Payload,
  depth: number,
  overrideAccess: boolean,
  req?: unknown,
): Promise<void> {
  const isPolymorphic = Array.isArray(field.relationTo);

  // Group IDs by collection slug
  const idsByCollection = new Map<string, Set<string>>();

  for (const doc of docs) {
    if (field.path.includes('.') && isArrayPath(doc, field.path)) {
      const arrayItems = getArrayItems(doc, field.path);
      for (const item of arrayItems) {
        collectIdsFromValue(item.value, field, isPolymorphic, idsByCollection);
      }
    } else {
      const value = getNestedValue(doc, field.path);
      collectIdsFromValue(value, field, isPolymorphic, idsByCollection);
    }
  }

  // Batch fetch all documents per collection
  const docMaps = new Map<string, Map<string | number, Record<string, unknown>>>();

  const fetchPromises = [...idsByCollection.entries()].map(async ([collectionSlug, ids]) => {
    if (ids.size === 0) return;

    try {
      const result = await payload.find({
        collection: collectionSlug as CollectionSlug,
        where: { id: { in: [...ids] } },
        depth: 0,
        limit: 0,
        pagination: false,
        overrideAccess,
        disableErrors: true,
        ...(req ? { req: req as never } : {}),
      });

      const map = new Map<string | number, Record<string, unknown>>();
      for (const fetchedDoc of result.docs) {
        const d = fetchedDoc as unknown as Record<string, unknown>;
        map.set(d.id as string | number, d);
      }
      docMaps.set(collectionSlug, map);
    } catch {
      // Access denied or error — leave IDs as-is
    }
  });

  await Promise.all(fetchPromises);

  // Replace IDs with populated docs
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

function parsePopulateOnly(raw: unknown): string[] | null {
  if (typeof raw === 'string' && raw.length > 0) {
    const slugs = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return slugs.length > 0 ? slugs : null;
  }
  return null;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const CONTEXT_KEY = '_selectivePopulate';

export const selectivePopulate = (options?: { paramName?: string }): Plugin => {
  const paramName = options?.paramName || 'populateOnly';

  return (config: Config): Config => {
    const existingOnInit = config.onInit;

    // ── onInit: wrap Local API (payload.find / payload.findByID) ──────────
    config.onInit = async (payload: Payload) => {
      if (existingOnInit) await existingOnInit(payload);

      const collections = payload.collections as Record<string, { config: { fields: Field[] } }>;

      // Wrap payload.find for Local API usage
      const originalFind = payload.find.bind(payload);
      (payload as any).find = async (findOptions: any) => {
        // Skip if called from afterOperation (avoid infinite loop)
        if (findOptions?.context?.[CONTEXT_KEY + '_internal']) {
          return originalFind(findOptions);
        }

        const spContext = getLocalApiContext(findOptions, paramName);
        if (!spContext) {
          return originalFind(findOptions);
        }

        const result = await originalFind({ ...findOptions, depth: 0 });

        const collection = collections[findOptions.collection];
        if (!collection?.config?.fields) return result;

        const relationFields = getRelationshipFields(collection.config.fields);
        const docs = result.docs as unknown as Record<string, unknown>[];
        await populateFields(
          docs,
          relationFields,
          spContext.allowedFields,
          payload,
          spContext.originalDepth,
          spContext.overrideAccess,
          findOptions.req,
        );

        return result;
      };

      // Wrap payload.findByID for Local API usage
      const originalFindByID = payload.findByID.bind(payload);
      (payload as any).findByID = async (opts: any) => {
        if (opts?.context?.[CONTEXT_KEY + '_internal']) {
          return originalFindByID(opts);
        }

        const spContext = getLocalApiContext(opts, paramName);
        if (!spContext) {
          return originalFindByID(opts);
        }

        const doc = await originalFindByID({ ...opts, depth: 0 });

        const collection = collections[opts.collection];
        if (!collection?.config?.fields) return doc;

        const relationFields = getRelationshipFields(collection.config.fields);
        const docs = [doc as unknown as Record<string, unknown>];
        await populateFields(
          docs,
          relationFields,
          spContext.allowedFields,
          payload,
          spContext.originalDepth,
          spContext.overrideAccess,
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
            ({ args, operation }: any) => {
              if (operation !== 'read') return args;

              const req = args.req;
              const rawParam = req?.query?.[paramName];
              const slugs = parsePopulateOnly(rawParam);
              if (!slugs) return args;

              const originalDepth = args.depth ?? req?.payload?.config?.defaultDepth ?? 1;

              // Store in req.context for afterOperation
              if (req?.context) {
                req.context[CONTEXT_KEY] = {
                  originalDepth,
                  allowedFields: new Set(slugs),
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
                  spContext.allowedFields,
                  payload,
                  spContext.originalDepth,
                  spContext.overrideAccess,
                  req,
                );
              } else if (operation === 'findByID' && result) {
                const docs = [result as unknown as Record<string, unknown>];
                await populateFields(
                  docs,
                  relationFields,
                  spContext.allowedFields,
                  payload,
                  spContext.originalDepth,
                  spContext.overrideAccess,
                  req,
                );
              }

              // Clean up context to avoid re-triggering on nested calls
              delete req.context[CONTEXT_KEY];

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
): SelectivePopulateContext | null {
  const ctx = options.context as Record<string, unknown> | undefined;
  if (!ctx?.[paramName]) return null;

  const slugs = ctx[paramName];
  const depth = options.depth ?? 1;
  if (Array.isArray(slugs)) {
    return {
      originalDepth: depth,
      allowedFields: new Set(slugs as string[]),
      overrideAccess: options.overrideAccess ?? true,
    };
  }
  return null;
}

export default [selectivePopulate()];
