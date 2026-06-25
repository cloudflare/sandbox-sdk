// Ambient declaration so the generated sidecar package (`sidecar-package.tgz`,
// produced by `build.ts`) can be imported directly. The bundler inlines the
// tarball bytes as a `Uint8Array`, which the SDK ships to the container to
// provision the interpreter sidecar.
declare module '*.tgz' {
  const data: Uint8Array;
  export default data;
}
