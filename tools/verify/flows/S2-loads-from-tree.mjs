// /context is a local command: the CLI answers it without a model call, and
// the session still emits its init event, which names every loaded plugin.
export const tier = "surface";

export const runs = [{ name: "context", args: ["/context"], stdin: "" }];
