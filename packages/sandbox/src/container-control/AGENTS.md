Add or extend DO-to-container control behavior here. Mirror new methods in
`packages/sandbox-container/src/control-plane/`.

Use role-based names such as `ContainerControlClient`,
`ContainerControlConnection`, and `DeferredTransport`. Avoid leaking capnweb as an
implementation detail unless the code directly interacts with capnweb types.
