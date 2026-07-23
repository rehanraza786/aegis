# Bundled third-party libraries

- `cytoscape.min.js` — Cytoscape.js 3.34.0, MIT license, https://js.cytoscape.org
  Bundled inside the vsix so the graph view renders with zero network egress
  (see PRIVACY.md).
- `edgehandles.min.js` — cytoscape-edgehandles 4.0.1, MIT license,
  https://github.com/cytoscape/cytoscape.js-edgehandles — bundled
  self-contained (inlines lodash.memoize and lodash.throttle, both MIT) so the
  drag-to-connect assert gesture works with zero network egress.

The SVG exporter is first-party code in graph-view.html (a purpose-built
serializer for the view's four node shapes) — the common cytoscape SVG plugin
is GPLv3, which cannot ship inside this MIT-licensed extension.
