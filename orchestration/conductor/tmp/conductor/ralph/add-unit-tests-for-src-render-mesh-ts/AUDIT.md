# AUDIT: Add unit tests for src/render/mesh.ts

## Stack

- Target project: `C:\Users\HOME\Desktop\minecraft-typescript`.
- Runtime: TypeScript 5.8, Vite 6, Vitest 2, happy-dom, Playwright for visual tests.
- Domain: WebGL2 rendering helpers for a Minecraft-style block viewer.

## File map

- `src/render/mesh.ts` — target file. Exports `createBuffer`, `createMesh`, `drawMesh`, `Mesh`, and attribute locations.
- `src/render/renderer.ts` — calls `createMesh` and `drawMesh` each frame.
- `src/render/gl.ts` — provides WebGL2 context and canvas resize.
- `src/render/shader.ts` — compiles shaders; `renderer.ts` consumes the program.
- `src/render/texture.ts` — creates the block atlas texture.
- `src/block/cube.ts` — builds cube geometry that matches the vertex layout in `mesh.ts`.
- `src/block/block.ts` — defines `BlockFace` and texture mapping.
- `src/math/mat4.ts` and `src/math/vec3.ts` — transform math used by the renderer.
- `tests/render/mesh.test.ts` — existing unit tests for the target file.
- `tests/mocks/webgl2.ts` — minimal WebGL2 mock used by the render tests.
- `tests/render/shader.test.ts`, `tests/render/texture.test.ts`, `tests/render/gl.test.ts` — related render tests.
- `tests/block/cube.test.ts`, `tests/block/block.test.ts` — geometry tests.
- `tests/math/mat4.test.ts` — matrix tests.
- `vite.config.ts` — configures Vitest with happy-dom and `tests/setup.ts`.

## Hotspots and risks

1. `tests/render/mesh.test.ts` already exists. The goal may be redundant unless coverage gaps are filled.
2. `createBuffer` tests only a `Float32Array`. The `Uint16Array` and `ArrayBuffer` paths are untested.
3. `createMesh` tests success, VAO failure, and attribute layout. It does not test buffer failure or malformed vertex data.
4. `drawMesh` has no negative tests. It only binds a VAO and calls `drawElements`.
5. Attribute location constants are verified indirectly through `vertexAttribPointer`. There is no explicit assertion for `POSITION_LOC`, `NORMAL_LOC`, `TEXCOORD_LOC`.
6. `mesh.ts` creates WebGL objects but never deletes them. Repeated calls leak GPU memory. No disposal tests exist.
7. The vertex layout is hard-coded: position 3, normal 3, texcoord 2. `src/block/cube.ts` must match this exactly. A layout change breaks both modules.
8. The mock returns objects with `_id`. Tests rely on this internal shape. If the mock changes, the tests break.
9. `createBuffer` casts `data as unknown as BufferSource`. This hides a real type mismatch.

## Evidence

- Read the target file, its renderer consumer, related render files, the cube geometry, and the mesh test and mock.
- Confirmed that `tests/render/mesh.test.ts` already exists and tests the three main exports.
- Did not run `npm test`. This subagent role does not include a shell tool.

## Recommendations

- Add `createBuffer` tests for `Uint16Array` and `ArrayBuffer`.
- Add a `createMesh` test that triggers a buffer creation failure.
- Add explicit tests for `POSITION_LOC`, `NORMAL_LOC`, `TEXCOORD_LOC`.
- Add a `disposeMesh` function and test it.
- Run `npm test` in the target project to verify the suite.
