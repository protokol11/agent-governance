# Plan: add unit tests for `src/render/mesh.ts`

## Scope

- Keep changes in the test suite only.
- Do not change `src/render/mesh.ts` unless a type error appears during verification.
- Fill the coverage gaps from `AUDIT.md` without widening the task. Do not add a `disposeMesh` function.

## Reference-first findings

- `src/render/mesh.ts` exports these items:
  - `POSITION_LOC`, `NORMAL_LOC`, `TEXCOORD_LOC`
  - `createBuffer(gl, data, target)`
  - `createMesh(gl, vertices, indices)`
  - `drawMesh(gl, mesh)`
- `tests/render/mesh.test.ts` already covers the happy paths for `createBuffer`, `createMesh`, and `drawMesh`.
- `tests/mocks/webgl2.ts` provides a minimal `WebGL2RenderingContext` proxy. The proxy returns objects with `_id`.
- Existing tests use `vi.spyOn` to simulate VAO creation failure. They also assert on `vertexAttribPointer` arguments.

## Design decisions

### How to test the missing `createBuffer` data types

**Option A:** Add three separate `it` blocks for `Float32Array`, `Uint16Array`, and `ArrayBuffer`.
**Option B:** Use a single `it.each` table.

**Chosen: Option A.** This matches the existing style in `mesh.test.ts`. It also makes failures easy to read.

### How to test `createMesh` buffer failure

**Option A:** Spy on `gl.createBuffer` and return `null`. This makes `createBuffer` throw. Then assert that `createMesh` propagates the error.
**Option B:** Mock the internal `createBuffer` function through a module import.

**Chosen: Option A.** `createBuffer` is not exported. Spying on the GL method avoids module-level mock plumbing.

## Changes to make

Edit `C:\Users\HOME\Desktop\minecraft-typescript\tests\render\mesh.test.ts`.

1. **Extend `createBuffer` tests.**
   - Add a test that passes a `Uint16Array` to `createBuffer`. Assert the returned buffer has `_id > 0`.
   - Add a test that passes an `ArrayBuffer` to `createBuffer`. Assert the returned buffer has `_id > 0`.
   - Add a spy on `gl.bufferData` for one of the new tests. Confirm it is called with the supplied data, target, and `gl.STATIC_DRAW`.

2. **Extend `createMesh` tests.**
   - Add a test that spies on `gl.createBuffer`. Return `null` so that `createBuffer` throws. Assert that `createMesh` throws the same `Failed to create WebGL buffer` error.

3. **Add explicit attribute location tests.**
   - Add a test or a `describe` block asserting the values of `POSITION_LOC`, `NORMAL_LOC`, and `TEXCOORD_LOC`. The values are `0`, `1`, and `2`.

4. **Add a `drawMesh` edge test.**
   - Call `drawMesh` with a manually built `Mesh` object. Assert that `bindVertexArray` and `drawElements` use the exact stored values. This protects the `Mesh` interface shape from accidental changes.

Do not change `tests/mocks/webgl2.ts`.

## Verification

Run these commands in the target project directory `C:\Users\HOME\Desktop\minecraft-typescript`:

```bash
npm install
npx tsc --noEmit
npm test
```

Expected results:

- `npx tsc --noEmit` exits with no diagnostics.
- `npm test` runs `tests/render/mesh.test.ts`. The new tests pass.

## Acceptance criteria

1. New tests exist for `Uint16Array` and `ArrayBuffer` inputs to `createBuffer`.
2. A new test exists for `createMesh` propagating a buffer creation failure.
3. Explicit tests exist for `POSITION_LOC`, `NORMAL_LOC`, and `TEXCOORD_LOC`.
4. `npx tsc --noEmit` is clean.
5. `npm test` passes.

## Residual risks

- The production code still leaks VAOs and buffers. No disposal function exists. This is out of scope for adding unit tests. Track it separately if needed.
- The WebGL2 mock uses `as unknown` casts and `_id` internals. The new tests will continue this existing pattern.
