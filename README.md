# payload-plugin-selective-populate

**Selective, capability-based relationship population for [Payload CMS](https://payloadcms.com) 3.**

Populate exactly the relationships you ask for — one avatar, a nested `owner.avatar`, nothing else — and, when you opt in, resolve owner-gated documents that are reachable through a parent the requester is already allowed to read, **without opening up that collection's read access.**

- 🎯 **Per-request, per-relation** — `?populateOnly[avatar]=true`, no over-fetching of the relations you didn't ask for.
- 🌳 **Deep, batched** — a recursive populate tree (`{ owner: { avatar: true } }`), one query per target collection per level. No N+1.
- 🔐 **Capability-based bypass** — opt specific collections into "resolve through an authorized parent" without weakening their direct read access.
- 🧩 **Zero call-site ceremony** — collections declare a default; callers override with a query param or Local API context.

> **⚠️ Read [Security](#security) before using `bypassAccessFor`.** The bypass is powerful and has one non-negotiable precondition. Skipping it creates an [IDOR](#the-one-rule-validate-references-at-write-time).

---

## Why this exists

Payload's native population is all-or-nothing per `depth`: at `depth: 1` it hydrates **every** relationship on the document, and it re-runs each target collection's read access with the requesting user — so a relation the user can't read directly is dropped back to an id.

Two things it can't express, that this plugin adds:

1. **"Hydrate only these relations, leave the rest as ids."** Native `select`/`populate` choose which *fields* of a populated doc come back, not which *relations* to populate at a given level.
2. **"Resolve this relation even though the user can't read the target directly — because they reached it through a parent they're allowed to see."** This is **capability-based authorization**, and Payload has no native equivalent.

If you only need (1), you may not need this plugin — reach for native `select`/`defaultPopulate` first. This plugin earns its place when you also need (2).

---

## Install

```bash
npm install payload-plugin-selective-populate
# or: pnpm add / yarn add / bun add
```

Peer dependency: `payload@^3`.

```ts
// payload.config.ts
import { buildConfig } from 'payload'
import { selectivePopulate } from 'payload-plugin-selective-populate'

export default buildConfig({
  // ...
  plugins: [
    selectivePopulate({
      // no collection's access is bypassed unless you list it here — see Security
      bypassAccessFor: [],
    }),
  ],
})
```

---

## Usage

### The populate tree

Everything is driven by a `PopulateTree` — a plain object where each key is a relationship field, and the value is either `true` (populate it, stop there) or a nested tree (populate it, then populate these relations on the fetched docs):

```ts
type PopulateTree = { [field: string]: true | PopulateTree }
```

```jsonc
{ "avatar": true }                    // populate avatar, one level
{ "owner": { "avatar": true } }       // populate owner, then owner.avatar
{ "owner": true, "cover": true }      // populate two relations, leave the rest as ids
```

The special string `"none"` means "the plugin is active, populate nothing" (useful as a default, see below).

### REST — the `populateOnly` query param

The tree is expressed with bracket notation (parsed by `qs`, like every other Payload query param):

```http
GET /api/users/123?populateOnly[avatar]=true
GET /api/games?populateOnly[owner][avatar]=true&populateOnly[players][avatar]=true
GET /api/users/123?populateOnly=none
```

### Local API — the `populateOnly` context

Pass the tree (or `'none'`) through `context`:

```ts
const user = await payload.findByID({
  collection: 'users',
  id,
  context: { populateOnly: { avatar: true } },
})

const games = await payload.find({
  collection: 'games',
  context: { populateOnly: { owner: { avatar: true }, players: { avatar: true } } },
})
```

An explicit query/context value always **replaces** the collection default below.

### Per-collection defaults — `custom.defaultPopulateOnly`

A collection can declare what to populate when no `populateOnly` is supplied. This is the official Payload `custom` extension point — no import needed, fully type-checked:

```ts
// collections/Users.ts
export const Users: CollectionConfig = {
  slug: 'users',
  custom: {
    defaultPopulateOnly: { avatar: true }, // reads of a user hydrate avatar by default
  },
  fields: [/* ... */],
}

// A collection that should populate nothing unless asked:
export const Media: CollectionConfig = {
  slug: 'media',
  custom: { defaultPopulateOnly: 'none' },
  // ...
}
```

TypeScript picks this up automatically — the plugin augments Payload's `CollectionCustom` interface.

---

## Compared to native `depth` / `select` / `populate`

Payload 3 already has capable population controls — use them first when they're enough. This plugin only covers what they **can't** express.

| Capability | `depth` | `select` / `populate` | `defaultPopulate` | **this plugin** |
|---|:---:|:---:|:---:|:---:|
| Hydrate relations N levels deep | ✅ | — | — | ✅ (via the tree) |
| Choose which **fields** of a populated doc come back | — | ✅ | ✅ (as a default) | ✅ (only the requested relations) |
| Hydrate **only some** relations, leave siblings as ids at the same level | ❌ (all-or-nothing per level) | partial¹ | — | ✅ |
| Driven per-request from the REST client | ✅ | ✅ | — | ✅ |
| Populate a relation the requester **can't read directly** (capability) | ❌ | ❌ | ❌ | ✅ (`bypassAccessFor`) |
| Respects target read access by default | ✅ | ✅ | ✅ | ✅ (bypass is opt-in) |

¹ `select` can *exclude* a relation (`select: { heavyRel: false }` — keeps everything else) or *include* only some fields (`select: { avatar: true }` — drops the rest, **including scalars**, unless you list them). Neither gives you "populate `avatar`, keep every scalar, return the other relations as ids" in a single shape — that's what the populate tree does.

**Rules of thumb**

- Want fewer fields from a populated relation? → native `populate` / `defaultPopulate`.
- Want to hydrate everything to a fixed depth? → native `depth`.
- Want to hydrate *specific* relations and leave the rest as ids, per request? → this plugin.
- Want to resolve an owner-gated relation reached through an authorized parent? → this plugin (`bypassAccessFor`) — then read [Security](#security).

When `populateOnly` (or a `defaultPopulateOnly`) is active for a read, the plugin forces `depth: 0` and takes over population — don't combine it with a native `depth` / `select` on the same request.

---

## Options

```ts
selectivePopulate({
  paramName: 'populateOnly',   // query-param / context key. Default: 'populateOnly'
  disableErrors: true,         // swallow access errors on nested finds. Default: true
  bypassAccessFor: [],         // ⚠️ collections whose read access is bypassed on populate
})
```

| Option | Type | Default | Description |
|---|---|---|---|
| `paramName` | `string` | `'populateOnly'` | The REST query param and Local API context key the plugin reads. |
| `disableErrors` | `boolean` | `true` | When a nested populate find fails (e.g. access denied), leave the id in place instead of throwing. Set `false` while debugging to surface failures. |
| `bypassAccessFor` | `CollectionSlug[]` | `[]` | Collections fetched with `overrideAccess: true` during population. **This bypasses their read access control.** See [Security](#security). |

---

## Security

This is the part that matters. Skim the rest, read this.

### What `bypassAccessFor` does

By default the plugin **respects** access control: a relation the requester can't read is left as an id (fail-closed — this is true even in the Local API, which normally defaults to `overrideAccess: true`). Collections listed in `bypassAccessFor` are the exception: during population they are fetched with `overrideAccess: true`, so their documents resolve **even when the requester has no direct read access to them.**

This exists for **owner-gated data that must be visible when reached through an authorized parent** — a private media asset that should appear as a user's avatar to anyone allowed to see that user, an image in a chat message visible to the room's members, and so on.

### Why it's capability-based (and why that's the right model)

Such a document **has no audience of its own.** Its audience is inherited from whatever parent you reach it through: a chat image is visible to the room's members, a public post's image to everyone, a friend-only profile picture to friends. Trying to encode all of that as a read-access `Where` on the target collection is combinatorial and couples it to every possible parent.

Capability-based authorization is the right model instead: **permission propagates from the parent to the child.** *"If you legitimately read the parent that holds this relation, you may read the related document."* That is exactly what `bypassAccessFor` implements — and what native Payload cannot.

### The one rule: validate references at write time

Capability-based population is safe **only if both** of these hold:

1. **The requester read the parent legitimately.** ✅ Guaranteed by the plugin — population runs *after* the parent's own read access has passed.
2. **The parent → child reference is legitimate — not forged.** ⚠️ **This is your responsibility, and the plugin cannot do it for you.**

`overrideAccess: true` resolves **any id present in the reference field.** If a user can set `post.image = <another user's private media id>` and then read that post, the bypass hands them data they were never allowed to see. This is an **IDOR** (Insecure Direct Object Reference): access granted on presentation of an id, with no check that the writer was entitled to reference it.

> Setting `data.owner = req.user.id` on the *parent* does **not** validate the *reference* — those are different fields.

**Therefore: every relationship field that points at a `bypassAccessFor` collection must validate, at write time, that the writer is entitled to reference the target** (they own it, or an explicit sharing rule applies). A reusable field `validate` does the job:

```ts
import type { CollectionSlug, Validate } from 'payload'

// A doc may only reference `targetSlug` if its writer is entitled to it.
// Without this, bypassAccessFor becomes an IDOR.
export const mustOwnRef =
  (targetSlug: CollectionSlug, ownerKey = 'owner'): Validate =>
  async (value, { req }) => {
    if (value == null) return true
    if (req.user?.role === 'admin') return true
    const id = typeof value === 'object' ? (value as { id: string }).id : value
    const doc = await req.payload
      .findByID({ collection: targetSlug, id, depth: 0, overrideAccess: true })
      .catch(() => null)
    if (!doc) return 'Referenced document not found'
    if ((doc as Record<string, unknown>)[ownerKey] === req.user?.id) return true
    // extend here (and only here) with legitimate sharing rules
    return 'You are not allowed to reference this document'
  }
```

```ts
// on every field pointing at a bypassed collection
{ name: 'avatar', type: 'relationship', relationTo: 'media', validate: mustOwnRef('media') }
```

**Fail closed.** Adding a slug to `bypassAccessFor` retroactively puts *every* relationship pointing at it, across your whole schema, under this rule. Audit them all — your exposure is only as strong as the weakest unvalidated reference.

### Guarantees & non-guarantees

- ✅ A non-bypassed collection's read access is fully respected; unauthorized relations stay as ids.
- ✅ The Local API is fail-closed: it does **not** inherit Payload's `overrideAccess: true` default; you must pass it explicitly to bypass a non-listed collection.
- ⚠️ `overrideAccess` also bypasses **field-level** read access on the bypassed collection. Don't list a collection carrying fields more sensitive than every possible parent's read implies.
- ⚠️ Ids are visible regardless — a relation you can't resolve stays an id, which leaks existence. This matches Payload's own behavior.

---

## How it works

- **REST** — a `beforeOperation` hook (registered first) captures the request and forces `depth: 0` so Payload populates nothing; an `afterOperation` hook then re-populates only the requested tree.
- **Local API** — `payload.find` / `payload.findByID` are wrapped in `onInit` to apply the same logic to `context.populateOnly`.
- **Batching** — ids are collected per target collection across all requested fields of a level and fetched in a single `find({ where: { id: { in: [...] } } })`, then the plugin recurses one level deeper on the fetched docs. Two fields pointing at the same collection share one query.
- **Recursion guard** — the populate tree is capped at a depth of **6** to stop malformed trees or relation cycles from exploding. Tree keys that match no relationship field emit a one-time `console.warn` (catches typos like `{ avatr: true }`).
- **Isolation** — nested populate finds run with `populateOnly: 'none'` forced on both their context and query, so they never re-enter the plugin.

---

## Limitations

- **Population depth is flat per relation.** A populated relation's *own* relations are not populated unless you request them explicitly in the tree — the plugin drives depth through the tree, not through Payload's `depth`.
- **Query params replace, never merge** with the collection default. There is no additive syntax.
- **REST expects the object form** (`populateOnly[avatar]=true`). A bare `populateOnly=avatar` is not a tree and falls back to the default; only `populateOnly=none` is accepted as a string.
- Not wired for `payload.db`, GraphQL resolvers, `findVersions`, `duplicate`, or `count`.

---

## License

MIT
