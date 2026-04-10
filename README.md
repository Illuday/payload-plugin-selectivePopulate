# payload-plugin-selective-populate

A Payload CMS plugin that adds **selective relationship population** to your API.

Payload populates relationships all-or-nothing based on `depth`. With this plugin, you can specify **exactly which fields** to populate while keeping everything else as IDs.

## The problem

```
GET /api/messages?depth=1
```

Returns **every** relationship fully populated (user, media, thread, etc.) even when you only need the media. Setting `depth=0` returns nothing populated. There's no middle ground.

## The solution

```
GET /api/messages?depth=1&populateOnly=media
```

Returns `media` fully populated, everything else stays as IDs. Zero unnecessary queries.

## Installation

Copy `payload.plugin.selectivePopulate.ts` into your project.

```ts
// payload.config.ts
import { selectivePopulate } from './payload.plugin.selectivePopulate'

export default buildConfig({
  // ...
  plugins: [selectivePopulate()],
})
```

## Usage

### REST API

```
GET /api/messages?depth=1&populateOnly=avatar
GET /api/messages?depth=1&populateOnly=avatar,game
GET /api/posts?depth=1&populateOnly=featuredImage,author
```

`populateOnly` accepts a comma-separated list of **field names**.

### Local API

```ts
const result = await payload.find({
  collection: 'messages',
  depth: 1,
  context: {
    populateOnly: ['avatar', 'game'],
  },
})
```

### Without the parameter

When `populateOnly` is omitted, Payload behaves exactly as before. No side effects.

## How it works

1. **`beforeOperation`** intercepts read operations, stores the requested fields, sets `depth: 0` so Payload skips all population
2. **`afterOperation`** batch-fetches only the requested relationships using `find({ where: { id: { in: [...] } } })` and injects them back into the response
3. For **Local API**, the `onInit` hook wraps `payload.find` and `payload.findByID` with the same logic

### Performance

| Scenario | DB queries |
|----------|-----------|
| `depth=1` (default) | 1 (docs) + 1 per related collection = **N+1** |
| `depth=1&populateOnly=media` | 1 (docs) + 1 (media batch) = **2** |
| `depth=0` | **1** |

Related documents are fetched in a single batched query per collection (`WHERE id IN (...)`), not one query per document.

## Features

- Works with `relationship`, `upload`, and polymorphic fields
- Works with `hasMany` relationships
- Works with nested fields (groups, arrays, blocks, tabs)
- Respects access control and field-level ACLs
- Graceful fallback: if a user doesn't have access to a related collection, the field stays as an ID instead of throwing Forbidden
- Populated documents are returned flat (`depth: 0`) to avoid cascading sub-population
- Automatic for all collections, no per-collection config needed

## Options

```ts
selectivePopulate({
  paramName: 'populateOnly', // default, customize the query parameter name
})
```

## Field matching

Fields are matched by **name**, not by collection slug:

```ts
// Collection config
{
  name: 'avatar',        // <-- this is what you use in populateOnly
  type: 'upload',
  relationTo: 'media',   // <-- NOT this
}
```

For nested fields, you can use either the field name or the full dot-path:

```
populateOnly=avatar           # matches any field named "avatar"
populateOnly=profile.avatar   # matches only "avatar" inside the "profile" group
```

## Requirements

- Payload CMS v3.x
- TypeScript (ships as `.ts`, no build step)

## License

MIT
