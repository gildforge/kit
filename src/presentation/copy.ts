export function bindCopy(root: Document) {
  const controller = new AbortController()
  root.addEventListener('click', (event) => {
    const button = (event.target as Element)?.closest<HTMLButtonElement>('button[data-copy]')
    if (!button) return
    void navigator.clipboard.writeText(button.dataset.copy!).then(() => {
      button.textContent = 'copied'
      setTimeout(() => { button.textContent = 'copy' }, 1500)
    }).catch(() => { button.textContent = 'Try again' })
  }, { signal: controller.signal })
  return () => controller.abort()
}
