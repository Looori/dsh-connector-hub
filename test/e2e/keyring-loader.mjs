export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@napi-rs/keyring') {
    return { url: new URL('./mock-keyring.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
