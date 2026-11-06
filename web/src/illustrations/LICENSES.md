# Illustration licenses

Every file in `svg/` is listed here with where it came from and its license. Add a row for each new file before using it.

## Licenses

| Library | Author | License | Checked | What it allows |
| --- | --- | --- | --- | --- |
| [Open Doodles](https://www.opendoodles.com/) | Pablo Stanley | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), public domain | 2026-11-06 | Copy, change and use commercially. No attribution, no fee. The site says: "Open Doodles … is a free set of sketchy illustrations … under the CC0 License." |
| [Open Peeps](https://www.openpeeps.com/) | Pablo Stanley | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), public domain | 2026-11-06 | The same. The site says: "Free for commercial and personal use under CC0 License." |

Both libraries are by the same artist, so the drawings share one line style.

**unDraw is deliberately not used.** Its license (checked 2026-11-06) forbids scripted or bulk downloading. It also forbids distributing its assets in packs, and this repository is public. Use it only after getting the owner's consent, and record the approval here.

## Files

| File | Registry name | Source file | Source |
| --- | --- | --- | --- |
| `sitting-reading.svg` | `dashboard.getting-started` | `sitting-reading.svg` | Open Doodles |
| `strolling.svg` | `recruitment.empty` | `strolling.svg` | Open Doodles |
| `team.svg` | `employees.empty` | `sit-stand-walk.svg` | Open Peeps |
| `unboxing.svg` | `payroll.empty` | `unboxing.svg` | Open Doodles |
| `chilling.svg` | `leave.all-clear` | `chilling.svg` | Open Doodles |
| `meditating.svg` | `leave.empty` | `meditating.svg` | Open Doodles |
| `reading.svg` | `documents.empty` | `reading.svg` | Open Doodles |
| `jumping.svg` | `sales.empty` | `jumping.svg` | Open Doodles |
| `levitate.svg` | `empty.not-found` | `levitate.svg` | Open Doodles |

The Open Doodles files were downloaded from the library's own links (`opendoodles.s3-us-west-1.amazonaws.com`). The Open Peeps file came from the download link on openpeeps.com.

## How the files were changed

1. **Optimized with svgo 3:** multipass, 1-decimal precision, dimensions removed so the viewBox scales. This cut the files from 619 KB to 171 KB in total, with no visible change at display sizes.
2. **Colors moved to CSS.** The pink accent (`#FF5678`), black and white fills became the classes `il-a`, `il-i` and `il-p`, so the theme sets them (see `index.css`).
3. **Checked for unsafe content:** no scripts, event handlers or external links.

CC0 permits all of this.

## Adding an illustration

1. **Check the license.** It must be free for commercial use with no attribution required, or have written approval.
2. **Optimize it and move its colors to the classes above.** Save it as `svg/<name>.svg`.
3. **Register it.** Add one entry to `registry.ts`, and a row to the Files table above.
