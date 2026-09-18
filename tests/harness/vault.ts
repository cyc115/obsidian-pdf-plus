import { TFile } from 'obsidian';

/**
 * An in-memory stand-in for Obsidian's `Vault`, covering the parts the plugin's
 * file-writing paths touch.
 *
 * It reproduces the one behaviour that matters most for PDF editing: a write
 * fires a `modify` event for the file, which is what makes Obsidian reload an
 * open PDF view. Tests can count those events to assert how many reloads a
 * given user action costs.
 */
export class FakeVault {
    private files = new Map<string, TFile>();
    private contents = new Map<string, Uint8Array>();
    private handlers = new Map<string, Set<(...args: any[]) => any>>();

    /** Every `modify` event fired, in order. Useful for reload-count assertions. */
    modifyEvents: TFile[] = [];

    /** How many times the file bytes were read back from "disk". */
    readCount = 0;

    createBinaryFile(path: string, data: Uint8Array): TFile {
        const file = new TFile();
        file.path = path;
        file.name = path.split('/').pop()!;
        file.extension = file.name.split('.').pop()!;
        file.basename = file.name.slice(0, file.name.length - file.extension.length - 1);
        file.stat = { ctime: Date.now(), mtime: Date.now(), size: data.byteLength };
        file.vault = this as any;
        this.files.set(path, file);
        this.contents.set(path, data);
        return file;
    }

    getAbstractFileByPath(path: string) {
        return this.files.get(path) ?? null;
    }

    getFileByPath(path: string) {
        return this.files.get(path) ?? null;
    }

    async readBinary(file: TFile): Promise<ArrayBuffer> {
        this.readCount++;
        const data = this.contents.get(file.path);
        if (!data) throw new Error(`FakeVault: no such file: ${file.path}`);
        // Hand out a copy, like a real read from disk: callers must not be able to
        // mutate vault state through the buffer they got back.
        return data.slice().buffer as ArrayBuffer;
    }

    async modifyBinary(file: TFile, data: ArrayBuffer | Uint8Array): Promise<void> {
        const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
        this.contents.set(file.path, bytes);
        file.stat = { ...file.stat, mtime: Date.now(), size: bytes.byteLength };
        this.modifyEvents.push(file);
        this.trigger('modify', file);
    }

    async createFolder(_path: string) { }

    getResourcePath(file: TFile) {
        return `app://local/${file.path}?${file.stat.mtime}`;
    }

    on(name: string, callback: (...args: any[]) => any, ctx?: any) {
        if (!this.handlers.has(name)) this.handlers.set(name, new Set());
        const bound = ctx ? callback.bind(ctx) : callback;
        this.handlers.get(name)!.add(bound);
        return { name, callback: bound };
    }

    offref(ref: any) {
        if (ref) this.handlers.get(ref.name)?.delete(ref.callback);
    }

    trigger(name: string, ...args: any[]) {
        this.handlers.get(name)?.forEach((handler) => handler(...args));
    }

    /** Current bytes on "disk", for assertions that re-parse the file. */
    readBytes(file: TFile): Uint8Array {
        const data = this.contents.get(file.path);
        if (!data) throw new Error(`FakeVault: no such file: ${file.path}`);
        return data;
    }
}
