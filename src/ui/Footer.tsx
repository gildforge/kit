import { ThemeToggle } from './theme.js'
import { FooterView } from '../presentation/Headers.js'

/** Shared footer across all zones: author credit (cqx/zega pattern). */
export function Footer() {
  return <FooterView theme={<ThemeToggle />} />
}
