// Convert a human string to a safe UPPER_SNAKE_CASE slug for WIP value codes.
export function toSlug(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase()
    .slice(0, 60)
}
