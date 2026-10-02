# Todo list: agent guide

Change this list with `page_action`. Actions read the latest state and apply in one step, so there is nothing to merge or retry.

## Actions

{{actions}}

Items are named by id, or by their exact text when only one item has it. Columns are named by title or by index (0 is the first). The number of columns is a page setting the user picks.

## State

```
todos: [{ id, text, done, description, images: [{ id, name, data }], col }]   // col: column index
columnTitles: [string]
```

For anything the actions don't cover, read with `page_state` and a `path` (`todos/t_ab12`) and write with `page_update` ops. `description` is markdown; `![alt](#img-<image id>)` shows one of the item's images. To attach an image, insert into `todos/<id>/images` with `page_update`, pass the file in `assets`, and write `data: "asset:<file name>"`.
