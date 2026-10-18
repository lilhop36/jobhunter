# Source approval record: <source name>

> Copy this file to `docs/sources/<source-slug>.md` and fill it in.
>
> A source has an adapter **only** when **Status** reads `APPROVED`. Any other value -
> including an unedited `PENDING` - means no adapter may be written or enabled for it
> (SRS Appendix E: "A source without a recorded approval has no adapter").
>
> This is a template. It records no approval. Never copy it into service unedited.

- **Source:** <JobSource.name - must match the source's `name` exactly>
- **Status:** PENDING
- **Access mechanism:** <FEED | API | STATIC_HTML | BROWSER>
- **Robots and terms review:** <outcome (allowed / disallowed / conditions) and review date>
- **Stable job identifier field:** <source field name, or "none">
- **Declared calendar:** <GREGORIAN | ETHIOPIAN | UNKNOWN>
- **Declared currency:** <ISO-4217 code, or "none">
- **Canonical URL identity trusted:** <yes | no>
- **Expected results:** <UNKNOWN | RESULTS_EXPECTED | ZERO_EXPECTED>
- **Reviewed by:** <name>
- **Review date:** <YYYY-MM-DD>

## Decision rationale

<Why this source is legitimate and maintainable (ER-34): the access basis, the robots/terms
outcome, the rate limits to respect, and any conditions on use.>

## Notes

<Anything an implementer needs: pagination, locale, known data-quality quirks, the field the
source supplies for title/company/location.>
