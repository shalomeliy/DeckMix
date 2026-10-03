// node --import ./scripts/train/alias-register.mjs <script>
import { register } from 'node:module'
register('./alias-hooks.mjs', import.meta.url)
