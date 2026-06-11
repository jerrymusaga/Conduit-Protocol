/**
 * Minimal type declarations for `postmate` (the package ships no types). Covers
 * just the surface the passkey wallet uses: the parent `new Postmate(...)`
 * handshake → ChildAPI, and the child `new Postmate.Model(api)` → emit/then.
 */
declare module "postmate" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyData = any;

  interface ChildAPI {
    frame: HTMLIFrameElement;
    call(method: string, data?: unknown): void;
    on(event: string, callback: (data: AnyData) => void): void;
    get(property: string): Promise<AnyData>;
    destroy(): void;
  }

  class Postmate {
    constructor(options: {
      container: HTMLElement;
      url: string;
      name?: string;
      classListArray?: string[];
    });
    then(onfulfilled: (child: ChildAPI) => void): Promise<ChildAPI>;
  }

  namespace Postmate {
    class Model {
      constructor(api: Record<string, (...args: AnyData[]) => unknown>);
      emit(name: string, data?: unknown): void;
      then(onfulfilled: (model: Model) => void): Promise<Model>;
    }
  }

  export default Postmate;
}
