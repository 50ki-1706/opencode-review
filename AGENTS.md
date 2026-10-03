# Coding conventions

- Use strict TypeScript for Action code and infer validated input types from Valibot schemas.
- Keep runtime dependencies minimal; prefer Node built-ins and standard `fetch`.
- Keep producer-specific code outside the review core and Action bundle.
- Validate external data at boundaries; pass subprocess arguments without shell interpolation.
- Keep functions small and explicit. Add focused tests for behavior and boundary cases.
- Use the project-pinned Node.js and pnpm versions through `vp`.
