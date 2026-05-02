export interface MountAdapter {
  readonly platform: "darwin" | "linux" | "win32";
  isMounted(path: string): Promise<boolean>;
  mount(url: string, path: string): Promise<void>;
  unmount(path: string): Promise<void>;
}
