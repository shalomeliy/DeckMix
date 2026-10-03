// Lets plain Node run src/ files that import with the project's `@/` alias (the same alias vite and tsc use).
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = new URL('../../src/', import.meta.url)
    const path = specifier.slice(2)
    return next(new URL(/\.[a-z]+$/.test(path) ? path : `${path}.ts`, base).href, context)
  }
  return next(specifier, context)
}
