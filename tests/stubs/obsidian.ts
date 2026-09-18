/**
 * Runtime stub for the `obsidian` module.
 *
 * The published `obsidian` package is types-only (`"main": ""`), so anything the
 * plugin imports as a *value* has to exist here for tests to run outside the app.
 * Keep this deliberately thin: it exists so module graphs load, not to simulate
 * Obsidian. Behaviour a test actually depends on belongs in the fakes under
 * `tests/harness/`, where it is explicit.
 */

export class TAbstractFile {
    path = '';
    name = '';
    parent: any = null;
    vault: any = null;
}

export class TFile extends TAbstractFile {
    basename = '';
    extension = '';
    stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
    isRoot() { return this.path === '/'; }
}

/** Captures notices so tests can assert on user-facing errors. */
export class Notice {
    static messages: string[] = [];
    noticeEl: any = {};
    constructor(message: string | DocumentFragment, public duration?: number) {
        Notice.messages.push(typeof message === 'string' ? message : '[fragment]');
    }
    setMessage() { return this; }
    hide() { }
}

export class Events {
    private handlers = new Map<string, Set<(...args: any[]) => any>>();
    on(name: string, callback: (...args: any[]) => any, ctx?: any) {
        if (!this.handlers.has(name)) this.handlers.set(name, new Set());
        const bound = ctx ? callback.bind(ctx) : callback;
        this.handlers.get(name)!.add(bound);
        return { name, callback: bound } as any;
    }
    off(name: string, callback: (...args: any[]) => any) {
        this.handlers.get(name)?.delete(callback);
    }
    offref(ref: any) {
        if (ref) this.off(ref.name, ref.callback);
    }
    trigger(name: string, ...args: any[]) {
        this.handlers.get(name)?.forEach((handler) => handler(...args));
    }
    tryTrigger(ref: any, args: any[]) {
        ref?.callback?.(...args);
    }
}

export class Component {
    _loaded = false;
    _children: Component[] = [];
    _registered: (() => any)[] = [];
    load() {
        this._loaded = true;
        this.onload();
        this._children.forEach((child) => child.load());
    }
    onload() { }
    unload() {
        this._loaded = false;
        this._children.forEach((child) => child.unload());
        this._children = [];
        this._registered.forEach((cb) => cb());
        this._registered = [];
        this.onunload();
    }
    onunload() { }
    addChild<T extends Component>(child: T): T {
        this._children.push(child);
        if (this._loaded) child.load();
        return child;
    }
    removeChild<T extends Component>(child: T): T {
        this._children.remove?.(child);
        return child;
    }
    register(cb: () => any) { this._registered.push(cb); }
    registerEvent(_ref: any) { }
    registerDomEvent(..._args: any[]) { }
    registerInterval(id: number) { return id; }
}

export class MarkdownRenderChild extends Component {
    constructor(public containerEl: any) { super(); }
}

export class Scope {
    keys: any[] = [];
    register(modifiers: any, key: any, func: any) {
        const handler = { modifiers: Array.isArray(modifiers) ? modifiers.join(',') : modifiers, key, func };
        this.keys.push(handler);
        return handler;
    }
    unregister(handler: any) {
        const i = this.keys.indexOf(handler);
        if (i >= 0) this.keys.splice(i, 1);
    }
}

export class Menu {
    items: any[] = [];
    addItem(cb: (item: any) => any) {
        const item = {
            setTitle() { return item; }, setIcon() { return item; },
            setChecked() { return item; }, setDisabled() { return item; },
            setSection() { return item; }, onClick(fn: any) { item._onClick = fn; return item; },
            _onClick: null as any,
        };
        cb(item);
        this.items.push(item);
        return this;
    }
    addSeparator() { return this; }
    showAtMouseEvent() { return this; }
    showAtPosition() { return this; }
    hide() { return this; }
    register() { return this; }
}

export class AbstractInputSuggest<T> {
    constructor(public app: any, public inputEl: any) { }
    getSuggestions(_query: string): T[] | Promise<T[]> { return []; }
    renderSuggestion(_value: T, _el: any) { }
    selectSuggestion(_value: T) { }
    onSelect(_cb: any) { return this; }
    setValue(_value: string) { }
    close() { }
}

export class PluginSettingTab extends Component { constructor(public app?: any, public plugin?: any) { super(); } display() { } hide() { } }
export class Setting { constructor(public containerEl?: any) { } setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } }
export class Modal extends Component { constructor(public app?: any) { super(); } open() { } close() { } }
export class Plugin extends Component { constructor(public app?: any, public manifest?: any) { super(); } }

export const Platform = {
    isDesktopApp: true,
    isMobile: false,
    isMobileApp: false,
    isIosApp: false,
    isAndroidApp: false,
    isMacOS: false,
    isWin: false,
    isLinux: true,
    isSafari: false,
    resourcePathPrefix: 'app://local/',
};

export const Keymap = {
    isModifier: () => false,
    isModEvent: () => false,
};

export const apiVersion = '1.13.1';
export function requireApiVersion(_version: string) { return true; }

export function parseLinktext(linktext: string) {
    const index = linktext.indexOf('#');
    return index < 0
        ? { path: linktext, subpath: '' }
        : { path: linktext.slice(0, index), subpath: linktext.slice(index) };
}

export function normalizePath(path: string) {
    return path.replace(/([\\/])+/g, '/').replace(/(^\/|\/$)/g, '');
}

export function prepareFuzzySearch(_query: string) {
    return (_text: string) => null;
}

export function renderResults(..._args: any[]) { }
export function sortSearchResults(..._args: any[]) { }
export function setIcon(..._args: any[]) { }
export function setTooltip(..._args: any[]) { }

export function debounce<T extends (...args: any[]) => any>(cb: T, _timeout?: number, _resetTimer?: boolean) {
    const fn = ((...args: any[]) => cb(...args)) as any;
    fn.cancel = () => fn;
    fn.run = () => undefined;
    return fn;
}

export class MenuItem { }
export class MenuSeparator { }
export class MarkdownRenderer { static render(..._args: any[]) { return Promise.resolve(); } }
export class DropdownComponent { }
export class TextComponent { }
export class TextAreaComponent { }
