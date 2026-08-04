# Youwee Plugin Store

The plugin store catalog is loaded by Youwee from the `main` branch on GitHub, with the bundled catalog used as an offline fallback. To submit a plugin, open a pull request that updates `plugin-store/catalog.json`; once merged, users can see it without installing a new Youwee release.

## Requirements

- Package the plugin as a signed `.ywp` release asset.
- Use a fixed GitHub release URL such as `https://github.com/owner/repo/releases/download/v1.0.0/plugin.ywp`.
- Do not use `/latest/` URLs.
- Include the SHA256 of the `.ywp` package.
- Include the signer fingerprint from `signature.json`.
- Use `publisher.kind: "third-party"` unless the repository owner is `vanloctech`.

## Validate

Run:

```bash
bun run plugin-store:validate
```

The validator checks duplicate IDs, pinned URLs, checksum format, and official publisher rules.
