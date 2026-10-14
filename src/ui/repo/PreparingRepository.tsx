/** Worker-served Code/Score/commit pages read immutable HTML. If routing
 * reaches Next before the projection exists, it must not scan or score Git. */
export function PreparingRepository() {
  return <div data-artifact-pending="" role="status" style={{ padding: '48px 0' }}>
    <h1>Pending</h1>
    <p>This view is being prepared in the background.</p>
    <a href="" data-pending-retry="">Check again</a>
  </div>
}
