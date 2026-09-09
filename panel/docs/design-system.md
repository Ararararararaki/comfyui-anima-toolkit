# TK Toolkit Design System

TK Toolkit uses a Drinkit-inspired product language: tech-forward minimalism,
soft geometry, editorial typography and a single blue brand signal. It is an
influence, not a pixel copy of Drinkit assets or layouts.

## Tokens

The implementation lives in `src/styles/design-system.css`. The `--color-*`
variables are the public design tokens; the existing `--bg`, `--surface` and
`--accent` variables are compatibility aliases used by legacy feature styles.

| Group | Tokens |
| --- | --- |
| Brand | `--color-primary`, `--color-primary-hover`, `--color-primary-soft` |
| Surfaces | `--color-background`, `--color-surface`, `--color-surface-secondary` |
| Text | `--color-text`, `--color-text-secondary`, `--color-text-tertiary` |
| Geometry | `--ds-radius-sm`, `--ds-radius-md`, `--ds-radius-card`, `--ds-radius-lg`, `--ds-radius-pill` |
| Motion | `--ds-motion-fast`, `--ds-motion-standard`, `--ds-motion-slow`, `--ds-ease-out` |

## Usage rules

- Use blue only for brand actions, focus states and selection feedback. Green,
  orange and red remain semantic status colors, not competing brand colors.
- Prefer surface contrast and whitespace over borders and heavy shadows.
- Cards use `--ds-radius-card`; controls use `--ds-radius-sm` or
  `--ds-radius-md`; dialogs use `--ds-radius-lg`.
- Primary actions should be obvious within one interaction. Secondary actions
  use translucent surfaces and keep the text hierarchy quiet.
- Respect `prefers-reduced-motion`; the system disables transitions and long
  animations when requested.

## Themes

`drinkit` is the default light product theme. `mono` and `mono-light` remain
available for existing users and are intentionally not migrated automatically
when a saved theme already exists.

## Feature contract

The design layer must not own feature state. It styles the existing semantic
classes (`.btn`, `.card`, `.outputs-card`, `.local-grid-card`, dialogs and
toolbars), so new features can adopt the system without rewriting business
logic or persistence.
