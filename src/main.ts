import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate
} from "@codemirror/view";
import {
  App,
  Component,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TFile,
  normalizePath,
  setIcon
} from "obsidian";

const DATA_VERSION = 1;
const DATA_FOLDER = "Multi Definitions";
const DATA_FILE = `${DATA_FOLDER}/definitions.json`;
const MARK_CLASS = "multi-def-term";
const SKIPPED_ELEMENTS = new Set(["A", "BUTTON", "CODE", "INPUT", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);

interface DefinitionEntry {
  content: string;
  createdAt: number;
  id: string;
  title: string;
  updatedAt: number;
}

interface TermRecord {
  aliases: string[];
  definitions: DefinitionEntry[];
  id: string;
  term: string;
}

interface MultiDefinitionsSettings {
  bold: boolean;
  caseSensitive: boolean;
  enableHighlight: boolean;
  enableTextColor: boolean;
  highlightColor: string;
  hoverPreview: boolean;
  textColor: string;
  underline: boolean;
}

interface DictionaryData {
  settings: MultiDefinitionsSettings;
  terms: TermRecord[];
  version: number;
}

interface MatchEntry {
  key: string;
  text: string;
}

interface TextMatch {
  from: number;
  key: string;
  to: number;
}

const DEFAULT_SETTINGS: MultiDefinitionsSettings = {
  bold: false,
  caseSensitive: false,
  enableHighlight: true,
  enableTextColor: false,
  highlightColor: "#ffd43b",
  hoverPreview: true,
  textColor: "#1f2937",
  underline: false
};

const DEFAULT_DATA: DictionaryData = {
  settings: DEFAULT_SETTINGS,
  terms: [],
  version: DATA_VERSION
};

export default class MultiDefinitionsPlugin extends Plugin {
  settings = { ...DEFAULT_SETTINGS };
  private data: DictionaryData = {
    ...DEFAULT_DATA,
    settings: { ...DEFAULT_SETTINGS },
    terms: []
  };
  private editorGeneration = 0;
  private hoverPreview: DefinitionHoverPreview | null = null;
  private lastMarkedPointerType = "";
  private matchEntries: MatchEntry[] = [];
  private saveQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const localBackup = normalizeData(await this.loadData());
    this.data = await this.loadSyncedData(localBackup);
    this.settings = { ...this.data.settings };
    this.rebuildIndex();
    this.applyStyleSettings();

    this.registerEditorExtension(createDefinitionEditorExtension(this));
    this.registerMarkdownPostProcessor((element, context) => this.processReadingView(element, context));
    this.addSettingTab(new MultiDefinitionsSettingTab(this.app, this));

    this.addCommand({
      id: "add-definition",
      name: "Add definition",
      editorCallback: (editor) => this.openAddDefinition(editor)
    });
    this.addCommand({
      id: "manage-definitions",
      name: "Manage definitions",
      callback: () => new TermManagerModal(this.app, this).open()
    });
    this.addCommand({
      id: "refresh-definitions",
      name: "Refresh definitions",
      callback: () => void this.reloadSyncedData()
    });

    this.addRibbonIcon("book-open-text", "Manage definitions", () => {
      new TermManagerModal(this.app, this).open();
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => this.addEditorMenuItems(menu, editor))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === normalizePath(DATA_FILE)) {
          window.setTimeout(() => void this.reloadSyncedData(), 120);
        }
      })
    );

    this.registerDomEvent(document, "pointerdown", (event) => {
      const mark = closestMark(event.target);
      if (mark) {
        this.lastMarkedPointerType = event.pointerType;
      }
    }, { capture: true });
    this.registerDomEvent(document, "click", (event) => this.handleMarkedClick(event), { capture: true });
    this.registerDomEvent(document, "keydown", (event) => {
      const mark = closestMark(event.target);
      const key = mark?.dataset.multiDefKey;
      if (mark && key && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        this.openTerm(key);
      }
    });
    this.registerDomEvent(document, "pointerover", (event) => this.handleMarkedHover(event));
    this.registerDomEvent(document, "pointerout", (event) => this.handleMarkedPointerOut(event));
    this.register(() => this.closeHoverPreview());
  }

  getTerms(): TermRecord[] {
    return this.data.terms.map(cloneTerm);
  }

  getTerm(key: string): TermRecord | null {
    const normalized = normalizeKey(key);
    const term = this.data.terms.find((candidate) => normalizeKey(candidate.id) === normalized);
    return term ? cloneTerm(term) : null;
  }

  getDefinitionCount(key: string): number {
    return this.getTermInternal(key)?.definitions.length ?? 0;
  }

  findMatches(text: string, offset = 0): TextMatch[] {
    if (!text || this.matchEntries.length === 0) {
      return [];
    }
    const source = this.settings.caseSensitive ? text : text.toLocaleLowerCase();
    const candidates: TextMatch[] = [];
    for (const entry of this.matchEntries) {
      const needle = this.settings.caseSensitive ? entry.text : entry.text.toLocaleLowerCase();
      let cursor = 0;
      while (cursor <= source.length - needle.length) {
        const found = source.indexOf(needle, cursor);
        if (found < 0) {
          break;
        }
        const end = found + needle.length;
        if (hasValidBoundaries(text, found, end, entry.text)) {
          candidates.push({ from: offset + found, key: entry.key, to: offset + end });
        }
        cursor = found + Math.max(1, needle.length);
      }
    }
    candidates.sort((a, b) => a.from - b.from || b.to - a.to);
    const matches: TextMatch[] = [];
    let occupiedUntil = -1;
    for (const candidate of candidates) {
      if (candidate.from >= occupiedUntil) {
        matches.push(candidate);
        occupiedUntil = candidate.to;
      }
    }
    return matches;
  }

  getEditorGeneration(): number {
    return this.editorGeneration;
  }

  openTerm(key: string): void {
    const term = this.getTerm(key);
    if (!term) {
      return;
    }
    this.closeHoverPreview();
    new DefinitionViewerModal(this.app, this, term.id).open();
  }

  openDefinitionEditor(termId?: string, definitionId?: string): void {
    const term = termId ? this.getTerm(termId) : null;
    const definition = definitionId
      ? term?.definitions.find((candidate) => candidate.id === definitionId)
      : undefined;
    new DefinitionEditorModal(this.app, this, term, definition).open();
  }

  async saveDefinition(input: {
    aliases: string[];
    content: string;
    definitionId?: string;
    term: string;
    termId?: string;
    title: string;
  }): Promise<boolean> {
    const displayTerm = input.term.trim();
    const content = input.content.trim();
    if (!displayTerm || !content) {
      new Notice("Term and definition are required.");
      return false;
    }
    const aliases = uniqueStrings(input.aliases.map((alias) => alias.trim()).filter(Boolean));
    const conflicting = this.findConflictingTerm(displayTerm, aliases, input.termId);
    if (conflicting) {
      new Notice(`“${conflicting}” is already assigned to another term.`);
      return false;
    }

    const now = Date.now();
    let term = input.termId ? this.getTermInternal(input.termId) : null;
    if (!term) {
      term = {
        aliases,
        definitions: [],
        id: makeId("term"),
        term: displayTerm
      };
      this.data.terms.push(term);
    } else {
      term.term = displayTerm;
      term.aliases = aliases;
    }

    const existing = input.definitionId
      ? term.definitions.find((candidate) => candidate.id === input.definitionId)
      : undefined;
    if (existing) {
      existing.content = content;
      existing.title = input.title.trim();
      existing.updatedAt = now;
    } else {
      term.definitions.push({
        content,
        createdAt: now,
        id: makeId("definition"),
        title: input.title.trim(),
        updatedAt: now
      });
    }
    await this.persistAndRefresh();
    return true;
  }

  async deleteDefinition(termId: string, definitionId: string): Promise<void> {
    const term = this.getTermInternal(termId);
    if (!term) {
      return;
    }
    term.definitions = term.definitions.filter((definition) => definition.id !== definitionId);
    if (term.definitions.length === 0) {
      this.data.terms = this.data.terms.filter((candidate) => candidate.id !== term.id);
    }
    await this.persistAndRefresh();
  }

  async updateSetting(key: keyof MultiDefinitionsSettings, value: unknown): Promise<void> {
    switch (key) {
      case "bold":
        this.settings.bold = Boolean(value);
        break;
      case "caseSensitive":
        this.settings.caseSensitive = Boolean(value);
        break;
      case "enableHighlight":
        this.settings.enableHighlight = Boolean(value);
        break;
      case "enableTextColor":
        this.settings.enableTextColor = Boolean(value);
        break;
      case "hoverPreview":
        this.settings.hoverPreview = Boolean(value);
        break;
      case "underline":
        this.settings.underline = Boolean(value);
        break;
      case "highlightColor":
        this.settings.highlightColor =
          typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_SETTINGS.highlightColor;
        break;
      case "textColor":
        this.settings.textColor =
          typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_SETTINGS.textColor;
        break;
    }
    this.data.settings = { ...this.settings };
    await this.persistAndRefresh();
  }

  private openAddDefinition(editor: Editor): void {
    const selected = editor.getSelection().trim();
    const term = selected || wordAtCursor(editor);
    this.openDefinitionEditorForText(term);
  }

  private openDefinitionEditorForText(term: string): void {
    const existing = this.findTermByPhrase(term);
    if (existing) {
      this.openDefinitionEditor(existing.id);
    } else {
      new DefinitionEditorModal(this.app, this, null, undefined, term).open();
    }
  }

  private addEditorMenuItems(menu: Menu, editor: Editor): void {
    const selected = editor.getSelection().trim();
    const phrase = selected || wordAtCursor(editor);
    if (!phrase) {
      return;
    }
    const existing = this.findTermByPhrase(phrase);
    menu.addItem((item) => {
      item
        .setTitle(existing ? "Add another definition" : "Add definition")
        .setIcon("plus")
        .onClick(() => this.openDefinitionEditorForText(phrase));
    });
    if (existing) {
      menu.addItem((item) => {
        item
          .setTitle("View all definitions")
          .setIcon("book-open-text")
          .onClick(() => this.openTerm(existing.id));
      });
    }
  }

  private processReadingView(element: HTMLElement, context: MarkdownPostProcessorContext): void {
    if (context.sourcePath === normalizePath(DATA_FILE)) {
      return;
    }
    this.decorateReadingElement(element);
  }

  private decorateReadingElement(root: HTMLElement): void {
    if (root.closest(`.${MARK_CLASS}, .multi-def-card, .multi-def-modal`)) {
      return;
    }
    this.decorateNode(root);
  }

  private decorateNode(parent: Node): void {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent) {
        const matches = this.findMatches(child.textContent);
        if (matches.length > 0 && child.parentElement) {
          const container = child.parentElement.createSpan({ cls: "multi-def-text-wrapper" });
          let cursor = 0;
          for (const match of matches) {
            container.appendText(child.textContent.slice(cursor, match.from));
            const visibleText = child.textContent.slice(match.from, match.to);
            container.createSpan({
              cls: MARK_CLASS,
              attr: {
                "data-multi-def-key": match.key,
                role: "button",
                tabindex: "0",
                title: `${this.getDefinitionCount(match.key)} definitions`
              },
              text: visibleText
            });
            cursor = match.to;
          }
          container.appendText(child.textContent.slice(cursor));
          child.replaceWith(container);
        }
        continue;
      }
      if (child.instanceOf(HTMLElement)) {
        if (SKIPPED_ELEMENTS.has(child.tagName) || child.hasClass(MARK_CLASS)) {
          continue;
        }
        this.decorateNode(child);
      }
    }
  }

  private handleMarkedClick(event: MouseEvent): void {
    const mark = closestMark(event.target);
    if (!mark || this.lastMarkedPointerType === "pen") {
      return;
    }
    const selection = mark.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    const key = mark.dataset.multiDefKey;
    if (!key) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.openTerm(key);
  }

  private handleMarkedHover(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || !this.settings.hoverPreview) {
      return;
    }
    const mark = closestMark(event.target);
    const key = mark?.dataset.multiDefKey;
    if (!mark || !key) {
      return;
    }
    this.hoverPreview?.cancelClose();
    if (this.hoverPreview?.termId === key && this.hoverPreview.isActive()) {
      return;
    }
    this.closeHoverPreview();
    this.hoverPreview = new DefinitionHoverPreview(this, key, mark);
    this.hoverPreview.scheduleOpen();
  }

  private handleMarkedPointerOut(event: PointerEvent): void {
    if (event.pointerType !== "mouse") {
      return;
    }
    const mark = closestMark(event.target);
    if (!mark) {
      return;
    }
    if (event.relatedTarget instanceof Node && mark.contains(event.relatedTarget)) {
      return;
    }
    this.hoverPreview?.scheduleClose();
  }

  private closeHoverPreview(): void {
    this.hoverPreview?.close();
    this.hoverPreview = null;
  }

  private findTermByPhrase(phrase: string): TermRecord | null {
    const key = normalizeKey(phrase);
    const term = this.data.terms.find(
      (candidate) =>
        normalizeKey(candidate.term) === key ||
        candidate.aliases.some((alias) => normalizeKey(alias) === key)
    );
    return term ? cloneTerm(term) : null;
  }

  private findConflictingTerm(term: string, aliases: string[], currentId?: string): string | null {
    const phrases = [term, ...aliases].map(normalizeKey);
    for (const candidate of this.data.terms) {
      if (candidate.id === currentId) {
        continue;
      }
      for (const phrase of [candidate.term, ...candidate.aliases]) {
        if (phrases.includes(normalizeKey(phrase))) {
          return phrase;
        }
      }
    }
    return null;
  }

  private getTermInternal(key: string): TermRecord | null {
    const normalized = normalizeKey(key);
    return this.data.terms.find((term) => normalizeKey(term.id) === normalized) ?? null;
  }

  private rebuildIndex(): void {
    const entries: MatchEntry[] = [];
    const seen = new Set<string>();
    for (const term of this.data.terms) {
      for (const phrase of [term.term, ...term.aliases]) {
        const normalized = normalizeKey(phrase);
        if (!normalized || seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        entries.push({ key: term.id, text: phrase });
      }
    }
    entries.sort((a, b) => b.text.length - a.text.length);
    this.matchEntries = entries;
  }

  private async loadSyncedData(fallback: DictionaryData): Promise<DictionaryData> {
    let raw: string | null;
    try {
      raw = await this.readSyncedFile();
    } catch (error) {
      console.error("Could not load synchronized definitions.", error);
      new Notice("Definitions file could not be read; using the local backup.");
      return fallback;
    }
    if (raw === null) {
      this.data = fallback;
      await this.persistData();
      return fallback;
    }
    try {
      return normalizeData(JSON.parse(raw) as unknown);
    } catch (error) {
      console.error("Could not load synchronized definitions.", error);
      new Notice("Definitions file could not be read; using the local backup.");
      return fallback;
    }
  }

  private async readSyncedFile(): Promise<string | null> {
    const path = normalizePath(DATA_FILE);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.app.vault.cachedRead(file);
    }
    const adapter = this.app.vault.adapter;
    return (await adapter.exists(path)) ? adapter.read(path) : null;
  }

  private async reloadSyncedData(): Promise<void> {
    await this.saveQueue;
    try {
      const raw = await this.readSyncedFile();
      if (raw === null) {
        return;
      }
      this.data = normalizeData(JSON.parse(raw) as unknown);
      this.settings = { ...this.data.settings };
      this.refreshAll();
    } catch (error) {
      console.error("Could not refresh synchronized definitions.", error);
    }
  }

  private persistAndRefresh(): Promise<void> {
    this.data.settings = { ...this.settings };
    const promise = this.persistData();
    this.refreshAll();
    return promise;
  }

  private persistData(): Promise<void> {
    const snapshot = normalizeData(this.data);
    this.saveQueue = this.saveQueue
      .then(async () => {
        const adapter = this.app.vault.adapter;
        const folder = normalizePath(DATA_FOLDER);
        // The vault index may not be populated yet at startup, so check the disk too.
        if (!this.app.vault.getAbstractFileByPath(folder) && !(await adapter.exists(folder))) {
          try {
            await this.app.vault.createFolder(folder);
          } catch (error) {
            if (!(await adapter.exists(folder))) {
              throw error;
            }
          }
        }
        const path = normalizePath(DATA_FILE);
        const content = `${JSON.stringify(snapshot, null, 2)}\n`;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
        } else {
          await adapter.write(path, content);
        }
        await this.saveData(snapshot);
      })
      .catch((error) => {
        console.error("Could not save definitions.", error);
        new Notice("Could not save definitions to the synchronized folder.");
      });
    return this.saveQueue;
  }

  private refreshAll(): void {
    this.rebuildIndex();
    this.applyStyleSettings();
    this.editorGeneration += 1;
    this.app.workspace.updateOptions();
    for (const preview of Array.from(document.querySelectorAll<HTMLElement>(".markdown-preview-view"))) {
      for (const mark of Array.from(preview.querySelectorAll<HTMLElement>(`.${MARK_CLASS}`))) {
        mark.replaceWith(mark.textContent ?? "");
      }
      for (const wrapper of Array.from(preview.querySelectorAll<HTMLElement>(".multi-def-text-wrapper"))) {
        wrapper.replaceWith(wrapper.textContent ?? "");
      }
      preview.normalize();
      this.decorateReadingElement(preview);
    }
  }

  private applyStyleSettings(): void {
    const body = document.body;
    body.classList.toggle("multi-def-bold", this.settings.bold);
    body.classList.toggle("multi-def-highlight", this.settings.enableHighlight);
    body.classList.toggle("multi-def-text-color", this.settings.enableTextColor);
    body.classList.toggle("multi-def-underline", this.settings.underline);
    body.style.setProperty("--multi-def-highlight-color", this.settings.highlightColor);
    body.style.setProperty("--multi-def-text-color", this.settings.textColor);
  }
}

function createDefinitionEditorExtension(plugin: MultiDefinitionsPlugin) {
  class DefinitionMarker implements PluginValue {
    decorations: DecorationSet;
    private generation: number;

    constructor(private readonly view: EditorView) {
      this.generation = plugin.getEditorGeneration();
      this.decorations = buildEditorDecorations(view, plugin);
    }

    update(update: ViewUpdate): void {
      const generation = plugin.getEditorGeneration();
      if (update.docChanged || update.viewportChanged || generation !== this.generation) {
        this.generation = generation;
        this.decorations = buildEditorDecorations(update.view, plugin);
      }
    }
  }

  return ViewPlugin.fromClass(DefinitionMarker, {
    decorations: (value) => value.decorations
  });
}

function buildEditorDecorations(view: EditorView, plugin: MultiDefinitionsPlugin): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const matches: TextMatch[] = [];
  for (const range of view.visibleRanges) {
    matches.push(...plugin.findMatches(view.state.sliceDoc(range.from, range.to), range.from));
  }
  matches.sort((a, b) => a.from - b.from || b.to - a.to);
  let occupiedUntil = -1;
  for (const match of matches) {
    if (match.from < occupiedUntil) {
      continue;
    }
    occupiedUntil = match.to;
    builder.add(
      match.from,
      match.to,
      Decoration.mark({
        attributes: {
          "data-multi-def-key": match.key,
          role: "button",
          title: `${plugin.getDefinitionCount(match.key)} definitions`
        },
        class: MARK_CLASS
      })
    );
  }
  return builder.finish();
}

class DefinitionHoverPreview {
  readonly termId: string;
  private closeTimer: number | null = null;
  private component: Component | null = null;
  private element: HTMLElement | null = null;
  private openTimer: number | null = null;

  constructor(
    private readonly plugin: MultiDefinitionsPlugin,
    termId: string,
    private readonly target: HTMLElement
  ) {
    this.termId = termId;
  }

  scheduleOpen(): void {
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      void this.open();
    }, 180);
  }

  isActive(): boolean {
    return this.openTimer !== null || this.element !== null;
  }

  scheduleClose(): void {
    this.cancelClose();
    this.closeTimer = window.setTimeout(() => this.close(), 220);
  }

  cancelClose(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  close(): void {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.cancelClose();
    this.component?.unload();
    this.component = null;
    this.element?.remove();
    this.element = null;
  }

  private async open(): Promise<void> {
    const term = this.plugin.getTerm(this.termId);
    if (!term || !this.target.isConnected) {
      return;
    }
    const body = this.target.ownerDocument.body;
    const card = body.createDiv({ cls: "multi-def-hover-card multi-def-card" });
    this.element = card;
    card.addEventListener("pointerenter", () => this.cancelClose());
    card.addEventListener("pointerleave", () => this.scheduleClose());
    card.addEventListener("click", () => this.plugin.openTerm(term.id));
    card.createEl("h3", { text: term.term });
    card.createSpan({
      cls: "multi-def-count",
      text: `${term.definitions.length} definitions`
    });
    const component = new Component();
    component.load();
    this.component = component;
    for (const [index, definition] of term.definitions.entries()) {
      const section = card.createDiv({ cls: "multi-def-hover-definition" });
      section.createEl("strong", { text: definition.title || `Definition ${index + 1}` });
      const content = section.createDiv({ cls: "multi-def-rendered-content" });
      await MarkdownRenderer.render(this.plugin.app, definition.content, content, DATA_FILE, component);
    }
    const rect = this.target.getBoundingClientRect();
    const cardWidth = Math.min(420, Math.max(260, window.innerWidth - 24));
    const left = clamp(rect.left, 12, Math.max(12, window.innerWidth - cardWidth - 12));
    card.style.setProperty("--multi-def-card-left", `${left}px`);
    card.style.setProperty(
      "--multi-def-card-top",
      `${Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - card.offsetHeight - 12))}px`
    );
  }
}

class DefinitionViewerModal extends Modal {
  private renderComponent: Component | null = null;

  constructor(
    app: App,
    private readonly plugin: MultiDefinitionsPlugin,
    private readonly termId: string
  ) {
    super(app);
  }

  onOpen(): void {
    const term = this.plugin.getTerm(this.termId);
    if (!term) {
      this.close();
      return;
    }
    this.modalEl.addClass("multi-def-modal");
    this.renderComponent = new Component();
    this.renderComponent.load();
    this.setTitle(term.term);
    if (term.aliases.length > 0) {
      this.contentEl.createDiv({
        cls: "multi-def-aliases",
        text: `Aliases: ${term.aliases.join(", ")}`
      });
    }
    const summary = this.contentEl.createDiv({ cls: "multi-def-modal-summary" });
    summary.createSpan({ text: `${term.definitions.length} definitions` });
    const addButton = summary.createEl("button", { text: "Add another definition" });
    addButton.addEventListener("click", () => {
      this.close();
      this.plugin.openDefinitionEditor(term.id);
    });

    for (const [index, definition] of term.definitions.entries()) {
      const card = this.contentEl.createDiv({ cls: "multi-def-definition-card multi-def-card" });
      const header = card.createDiv({ cls: "multi-def-definition-header" });
      header.createEl("h3", { text: definition.title || `Definition ${index + 1}` });
      const actions = header.createDiv({ cls: "multi-def-definition-actions" });
      const edit = actions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "Edit definition", type: "button" }
      });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () => {
        this.close();
        this.plugin.openDefinitionEditor(term.id, definition.id);
      });
      const remove = actions.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "Delete definition", type: "button" }
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        new DeleteDefinitionModal(this.app, this.plugin, term.id, definition.id, definition.title).open();
        this.close();
      });
      const content = card.createDiv({ cls: "multi-def-rendered-content" });
      void MarkdownRenderer.render(
        this.app,
        definition.content,
        content,
        DATA_FILE,
        this.renderComponent
      );
    }
  }

  onClose(): void {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.contentEl.empty();
  }
}

class DefinitionEditorModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: MultiDefinitionsPlugin,
    private readonly term: TermRecord | null,
    private readonly definition?: DefinitionEntry,
    private readonly initialTerm = ""
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("multi-def-modal");
    this.setTitle(this.definition ? "Edit definition" : this.term ? "Add another definition" : "Add definition");

    let termValue = this.term?.term ?? this.initialTerm;
    let aliasesValue = this.term?.aliases.join(", ") ?? "";
    let titleValue = this.definition?.title ?? "";
    let contentValue = this.definition?.content ?? "";

    new Setting(this.contentEl)
      .setName("Term")
      .setDesc("The word or phrase that will be recognized in every note.")
      .addText((control) => {
        control.setValue(termValue);
        control.setDisabled(Boolean(this.term));
        control.onChange((value) => {
          termValue = value;
        });
      });
    new Setting(this.contentEl)
      .setName("Aliases")
      .setDesc("Optional comma-separated alternative names.")
      .addText((control) => {
        control.setValue(aliasesValue);
        control.onChange((value) => {
          aliasesValue = value;
        });
      });
    new Setting(this.contentEl)
      .setName("Explanation title")
      .setDesc("Optional, useful when one term has definitions from different sources.")
      .addText((control) => {
        control.setValue(titleValue);
        control.onChange((value) => {
          titleValue = value;
        });
      });
    this.contentEl.createEl("label", {
      cls: "multi-def-editor-label",
      attr: { for: "multi-def-content" },
      text: "Definition"
    });
    const content = this.contentEl.createEl("textarea", {
      cls: "multi-def-editor-content",
      attr: {
        id: "multi-def-content",
        placeholder: "Markdown is supported."
      }
    });
    content.value = contentValue;
    content.addEventListener("input", () => {
      contentValue = content.value;
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    save.addEventListener("click", () => {
      void this.plugin.saveDefinition({
        aliases: aliasesValue.split(","),
        content: contentValue,
        definitionId: this.definition?.id,
        term: termValue,
        termId: this.term?.id,
        title: titleValue
      }).then((saved) => {
        if (saved) {
          this.close();
          const updated = this.term ? this.term.id : this.plugin.getTerms().find(
            (candidate) => normalizeKey(candidate.term) === normalizeKey(termValue)
          )?.id;
          if (updated) {
            this.plugin.openTerm(updated);
          }
        }
      });
    });
    this.scope.register(["Mod"], "Enter", () => save.click());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DeleteDefinitionModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: MultiDefinitionsPlugin,
    private readonly termId: string,
    private readonly definitionId: string,
    private readonly title: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Delete definition?");
    this.contentEl.createEl("p", {
      text: this.title ? `Delete “${this.title}”?` : "This definition will be permanently removed."
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const remove = actions.createEl("button", { cls: "mod-warning", text: "Delete" });
    remove.addEventListener("click", () => {
      void this.plugin.deleteDefinition(this.termId, this.definitionId);
      this.close();
    });
  }
}

class TermManagerModal extends Modal {
  constructor(app: App, private readonly plugin: MultiDefinitionsPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("multi-def-modal", "multi-def-manager");
    this.setTitle("Multi Definitions");
    const toolbar = this.contentEl.createDiv({ cls: "multi-def-manager-toolbar" });
    const search = toolbar.createEl("input", {
      attr: { "aria-label": "Search terms", placeholder: "Search terms…" },
      type: "search"
    });
    const add = toolbar.createEl("button", { text: "Add term" });
    add.addEventListener("click", () => {
      this.close();
      this.plugin.openDefinitionEditor();
    });
    const list = this.contentEl.createDiv({ cls: "multi-def-term-list" });
    const render = (): void => {
      list.empty();
      const query = normalizeKey(search.value);
      const terms = this.plugin.getTerms().filter((term) =>
        [term.term, ...term.aliases].some((phrase) => normalizeKey(phrase).includes(query))
      );
      if (terms.length === 0) {
        list.createDiv({ cls: "multi-def-empty", text: "No matching terms." });
        return;
      }
      for (const term of terms) {
        const row = list.createEl("button", { cls: "multi-def-term-row", type: "button" });
        const text = row.createDiv();
        text.createEl("strong", { text: term.term });
        if (term.aliases.length > 0) {
          text.createDiv({ cls: "multi-def-aliases", text: term.aliases.join(", ") });
        }
        row.createSpan({
          cls: "multi-def-count",
          text: String(term.definitions.length)
        });
        row.addEventListener("click", () => {
          this.close();
          this.plugin.openTerm(term.id);
        });
      }
    };
    search.addEventListener("input", render);
    render();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

type SettingKey = keyof MultiDefinitionsSettings;

class MultiDefinitionsSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: MultiDefinitionsPlugin) {
    super(app, owner);
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    return [
      {
        name: "Term appearance",
        type: "group",
        items: [
          {
            name: "Bold",
            desc: "Display recognized terms in bold.",
            control: { type: "toggle", key: "bold" }
          },
          {
            name: "Highlight",
            desc: "Display a colored background behind recognized terms.",
            control: { type: "toggle", key: "enableHighlight" }
          },
          {
            name: "Highlight color",
            control: { type: "color", key: "highlightColor" }
          },
          {
            name: "Custom text color",
            control: { type: "toggle", key: "enableTextColor" }
          },
          {
            name: "Text color",
            control: { type: "color", key: "textColor" }
          },
          {
            name: "Underline",
            control: { type: "toggle", key: "underline" }
          }
        ]
      },
      {
        name: "Interaction",
        type: "group",
        items: [
          {
            name: "Mouse hover preview",
            desc: "On desktop, show definitions when the mouse rests on a term.",
            control: { type: "toggle", key: "hoverPreview" }
          },
          {
            name: "Case-sensitive matching",
            desc: "Require capitalization to match the saved term or alias.",
            control: { type: "toggle", key: "caseSensitive" }
          }
        ]
      }
    ];
  }

  getControlValue(key: string): unknown {
    return this.owner.settings[key as SettingKey];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await this.owner.updateSetting(key as SettingKey, value);
  }
}

function closestMark(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(`.${MARK_CLASS}`) : null;
}

function wordAtCursor(editor: Editor): string {
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  const isPart = (value: string): boolean => /[\p{L}\p{N}_-]/u.test(value);
  let start = cursor.ch;
  let end = cursor.ch;
  while (start > 0 && isPart(line[start - 1])) {
    start -= 1;
  }
  while (end < line.length && isPart(line[end])) {
    end += 1;
  }
  return line.slice(start, end).trim();
}

function hasValidBoundaries(text: string, from: number, to: number, phrase: string): boolean {
  if (/\p{Script=Han}/u.test(phrase)) {
    return true;
  }
  const isWord = (value: string | undefined): boolean =>
    value !== undefined && /[\p{L}\p{N}_]/u.test(value);
  return !isWord(text[from - 1]) && !isWord(text[to]);
}

function normalizeData(value: unknown): DictionaryData {
  if (!value || typeof value !== "object") {
    return {
      settings: { ...DEFAULT_SETTINGS },
      terms: [],
      version: DATA_VERSION
    };
  }
  const source = value as Partial<DictionaryData>;
  const terms = Array.isArray(source.terms)
    ? source.terms.map(normalizeTerm).filter((term): term is TermRecord => term !== null)
    : [];
  return {
    settings: normalizeSettings(source.settings),
    terms,
    version: DATA_VERSION
  };
}

function normalizeTerm(value: unknown): TermRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<TermRecord>;
  if (typeof source.term !== "string" || !source.term.trim()) {
    return null;
  }
  const definitions = Array.isArray(source.definitions)
    ? source.definitions
        .map(normalizeDefinition)
        .filter((definition): definition is DefinitionEntry => definition !== null)
    : [];
  if (definitions.length === 0) {
    return null;
  }
  return {
    aliases: Array.isArray(source.aliases)
      ? uniqueStrings(source.aliases.filter((alias): alias is string => typeof alias === "string"))
      : [],
    definitions,
    id: typeof source.id === "string" && source.id ? source.id : makeId("term"),
    term: source.term.trim()
  };
}

function normalizeDefinition(value: unknown): DefinitionEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<DefinitionEntry>;
  if (typeof source.content !== "string" || !source.content.trim()) {
    return null;
  }
  const createdAt = typeof source.createdAt === "number" ? source.createdAt : Date.now();
  return {
    content: source.content.trim(),
    createdAt,
    id: typeof source.id === "string" && source.id ? source.id : makeId("definition"),
    title: typeof source.title === "string" ? source.title.trim() : "",
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : createdAt
  };
}

function normalizeSettings(value: unknown): MultiDefinitionsSettings {
  const source = value && typeof value === "object" ? value as Partial<MultiDefinitionsSettings> : {};
  return {
    bold: typeof source.bold === "boolean" ? source.bold : DEFAULT_SETTINGS.bold,
    caseSensitive: typeof source.caseSensitive === "boolean"
      ? source.caseSensitive
      : DEFAULT_SETTINGS.caseSensitive,
    enableHighlight: typeof source.enableHighlight === "boolean"
      ? source.enableHighlight
      : DEFAULT_SETTINGS.enableHighlight,
    enableTextColor: typeof source.enableTextColor === "boolean"
      ? source.enableTextColor
      : DEFAULT_SETTINGS.enableTextColor,
    highlightColor: normalizeColor(source.highlightColor, DEFAULT_SETTINGS.highlightColor),
    hoverPreview: typeof source.hoverPreview === "boolean"
      ? source.hoverPreview
      : DEFAULT_SETTINGS.hoverPreview,
    textColor: normalizeColor(source.textColor, DEFAULT_SETTINGS.textColor),
    underline: typeof source.underline === "boolean" ? source.underline : DEFAULT_SETTINGS.underline
  };
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function cloneTerm(term: TermRecord): TermRecord {
  return {
    aliases: [...term.aliases],
    definitions: term.definitions.map((definition) => ({ ...definition })),
    id: term.id,
    term: term.term
  };
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizeKey(trimmed);
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
