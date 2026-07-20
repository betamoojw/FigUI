import { execSync } from 'child_process'
import { readFileSync, writeFileSync, statSync, existsSync } from 'fs'
import { gzipAsync } from '@gfx/zopfli'

const KB = 1024
const ESP32_SPIFFS_LIMIT = 178 * KB

function hr() { console.log('-'.repeat(50)) }
function fmt(bytes) { return `${(bytes / KB).toFixed(1)} KB` }

hr()
console.log('FigUI - ESP32 Build Pipeline')
hr()

console.log('\n[1/4] Extracting Tailwind class registry...\n')
execSync('npx --no-install tw-patch install', { stdio: 'inherit' })
execSync('npx --no-install tw-patch extract', { stdio: 'inherit' })

console.log('\n[2/4] Compiling & bundling (vite esp32 mode)...\n')
execSync('npx vite build --mode esp32', { stdio: 'inherit' })

console.log('\n[3/4] Reading output...')
const htmlPath = 'dist/index.html'
let html = readFileSync(htmlPath, 'utf8')
console.log(`  index.html  ${fmt(Buffer.byteLength(html))}`)

const faviconPath = 'public/favicon.png'
if (existsSync(faviconPath)) {
  const faviconB64 = readFileSync(faviconPath).toString('base64')
  const dataUri = `data:image/png;base64,${faviconB64}`
  html = html.replace(
    /<link rel="icon"[^>]*>/,
    `<link rel="icon" type="image/png" href="${dataUri}">`
  )
  console.log(`  favicon.png inlined (${fmt(faviconB64.length * 0.75)})`)
}
writeFileSync(htmlPath, html)

console.log('\n[4/4] Compressing with Zopfli...')
const gz = await gzipAsync(Buffer.from(html), { numiterations: 15 })
const outPath = 'dist/index.html.gz'
writeFileSync(outPath, gz)

hr()
const ratio = ((1 - gz.length / html.length) * 100).toFixed(1)
console.log(`Output      : ${outPath}`)
console.log(`Uncompressed: ${fmt(html.length)}`)
console.log(`Compressed  : ${fmt(gz.length)}  (${ratio}% reduction)`)

if (gz.length > ESP32_SPIFFS_LIMIT) {
  console.warn(`\nWARNING: ${fmt(gz.length)} exceeds typical SPIFFS limit of ${fmt(ESP32_SPIFFS_LIMIT)}`)
  console.warn('   Consider reducing font imports or splitting code.')
} else {
  const pct = ((gz.length / ESP32_SPIFFS_LIMIT) * 100).toFixed(1)
  console.log(`ESP32 usage : ${pct}% of ${fmt(ESP32_SPIFFS_LIMIT)} limit`)
}
hr()
