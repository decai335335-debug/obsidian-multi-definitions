# Multi Definitions

An Obsidian personal dictionary where one term can have multiple saved explanations.

## Features

- Save any number of explanations for the same term.
- Optional aliases for every term.
- Automatically recognizes saved terms in Reading View and Live Preview.
- Desktop mouse hover shows a quick preview containing all explanations.
- Mouse click or tablet finger tap opens the full definition card.
- Stylus input is ignored by the definition interaction, preventing accidental popups while writing.
- Add, edit, and delete individual explanations.
- Markdown is supported inside explanations.
- Longest-term-first matching prevents a short term from replacing part of a longer saved phrase.
- Works with Chinese terms and English word boundaries.
- Appearance controls:
  - Bold
  - Background highlight
  - Custom highlight color
  - Custom text color
  - Underline
- Definitions and appearance settings are stored in `Multi Definitions/definitions.json` inside the vault for cross-device synchronization.

## Usage

### Add a definition

1. Select a term in the editor.
2. Run **Multi Definitions: Add definition**, or use the editor context menu.
3. Enter an optional explanation title, aliases, and the explanation.
4. To add another explanation later, use **Add another definition**.

### View definitions

- Desktop: rest the mouse on a marked term for a quick preview, or click for the full card.
- Tablet: tap the marked term with one finger.
- Keyboard: focus a marked term and press Enter or Space.
- Stylus: does not open definition cards.

### Manage the dictionary

Select the book icon in the ribbon or run **Multi Definitions: Manage definitions**.

## Storage and synchronization

The synchronized source of truth is:

```text
Multi Definitions/definitions.json
```

This regular vault file works with Obsidian Sync, Git, Syncthing, OneDrive, and other vault synchronization methods. A plugin-local backup is also maintained.

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `.obsidian/plugins/multi-definitions/` inside the vault.
3. Copy the three files into that folder.
4. Restart Obsidian and enable **Multi Definitions**.

Obsidian 1.13.0 or later is required.

## Development

```bash
pnpm install
pnpm run check
pnpm run build
```

## Attribution

This project is an independent implementation inspired by [Obsidian Note Definitions](https://github.com/dominiclet/obsidian-note-definitions), which is licensed under the MIT License. Multi Definitions uses a new array-based data model to support multiple explanations per term.

## License

[MIT](LICENSE)

---

## 中文说明

Multi Definitions 是一个支持“一条名词保存多条解释”的 Obsidian 个人词典插件。

- 在任意笔记中自动识别已经保存的名词。
- 电脑端鼠标悬停显示快速预览，鼠标单击打开完整解释卡片。
- 平板端用手指单击名词查看全部解释。
- 手写笔不会触发解释卡片，避免书写时误触。
- 同一个名词可以保存任意多条解释，并可分别编辑或删除。
- 可以为名词设置别名。
- 可以调节名词样式：加粗、荧光背景、背景颜色、文字颜色和下划线。
- 数据保存在仓库内的 `Multi Definitions/definitions.json`，能够同步到电脑和平板。

