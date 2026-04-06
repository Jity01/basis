declare module "screenshot-desktop" {
  function screenshot(options?: { format?: string }): Promise<Buffer>;
  export = screenshot;
}
