import { listFiles, fetchFileContent, getBase, createDir, deleteFile, deleteDir, uploadFile } from './http'
import type { Plugin, PluginManifest, StoreEntry } from '../types'

const PLUGINS_PATH = '/plugins'
export const PLUGIN_SD_REQUIRED_MESSAGE = 'Plugins can only be installed on SD storage. Please insert an SD card and try again.'

export const STORE_REGISTRY_URL = import.meta.env.DEV
  ? '/plugins/registry.json'
  : 'https://raw.githubusercontent.com/figamore/FigUI/main/plugins/registry.json'

async function scanFs(fs: 'sd' | 'local'): Promise<Plugin[]> {
  const result = await listFiles(PLUGINS_PATH, fs)
  const dirs = result.files.filter(f => f.isDir)
  const plugins: Plugin[] = []
  for (const dir of dirs) {
    try {
      const manifestPath = fs === 'sd'
        ? `/sd${PLUGINS_PATH}/${dir.name}/plugin.json`
        : `${PLUGINS_PATH}/${dir.name}/plugin.json`
      const text = await fetchFileContent(manifestPath, fs)
      const manifest: PluginManifest = JSON.parse(text)
      if (!manifest.name) continue
      const base = fs === 'sd'
        ? `${getBase()}/sd${PLUGINS_PATH}/${dir.name}`
        : `${getBase()}${PLUGINS_PATH}/${dir.name}`
      const entryUrl = `${base}/${manifest.entry ?? 'index.html'}`
      if (manifest.icon && !manifest.icon.startsWith('http'))
        manifest.icon = `${base}/${manifest.icon}`
      plugins.push({ id: dir.name, manifest, entryUrl, fs })
    } catch {}
  }
  for (const plugin of plugins) {
    if (plugin.manifest.icon) {
      try {
        const res = await fetch(plugin.manifest.icon)
        if (res.ok) plugin.manifest.icon = URL.createObjectURL(await res.blob())
      } catch {}
    }
  }
  return plugins
}

export async function discoverPlugins(): Promise<Plugin[]> {
  const [local, sd] = await Promise.allSettled([
    scanFs('local'),
    scanFs('sd'),
  ])
  return [
    ...(local.status === 'fulfilled' ? local.value : []),
    ...(sd.status === 'fulfilled' ? sd.value : []),
  ]
}

export async function uploadFolderPlugin(
  files: FileList,
  fs: 'sd' | 'local',
  onProgress: (current: number, total: number, filename: string) => void,
): Promise<string> {
  const all = Array.from(files)

  const manifestFile = all.find(f => f.name === 'plugin.json')
  if (!manifestFile) throw new Error('No plugin.json found in folder root')

  let manifest: PluginManifest
  try {
    manifest = JSON.parse(await manifestFile.text())
  } catch {
    throw new Error('plugin.json is not valid JSON')
  }
  if (!manifest.name) throw new Error('plugin.json must have a "name" field')

  const firstPath = all[0]?.webkitRelativePath ?? ''
  const folderName = firstPath.includes('/')
    ? firstPath.split('/')[0]
    : manifest.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  const rootFiles = all.filter(f => f.webkitRelativePath.split('/').length <= 2)

  try { await createDir('/', 'plugins', fs) } catch {}
  try { await createDir(PLUGINS_PATH, folderName, fs) } catch {}

  const targetDir = `${PLUGINS_PATH}/${folderName}`

  for (let i = 0; i < rootFiles.length; i++) {
    const file = rootFiles[i]
    const parts = file.webkitRelativePath.split('/')
    const filename = parts.length > 1 ? parts[1] : file.name
    onProgress(i + 1, rootFiles.length, filename)
    await uploadFile(targetDir, new File([file], filename, { type: file.type }), fs)
  }

  return folderName
}

export async function installStorePlugin(
  entry: StoreEntry,
  fs: 'sd' | 'local',
  onProgress: (current: number, total: number, filename: string) => void,
  options: { cleanExisting?: boolean } = {},
): Promise<void> {
  const manifestRes = await fetch(entry.base + 'plugin.json')
  if (!manifestRes.ok) throw new Error(`Failed to fetch plugin.json: HTTP ${manifestRes.status}`)
  const manifest: PluginManifest = await manifestRes.json()
  const files: string[] = manifest.files?.length
    ? ['plugin.json', ...manifest.files.filter(f => f !== 'plugin.json')]
    : ['plugin.json', manifest.entry ?? 'index.html',
       ...(manifest.icon && !manifest.icon.startsWith('http') ? [manifest.icon] : [])]

  try { await createDir('/', 'plugins', fs) } catch {}
  try { await createDir(PLUGINS_PATH, entry.id, fs) } catch {}

  const targetDir = `${PLUGINS_PATH}/${entry.id}`

  if (options.cleanExisting) {
    try {
      const existing = await listFiles(targetDir, fs)
      const nextFiles = new Set(files)
      for (const file of existing.files.filter(f => !f.isDir && !nextFiles.has(f.name))) {
        await deleteFile(targetDir, file.name, fs)
      }
    } catch {}
  }

  for (let i = 0; i < files.length; i++) {
    const filename = files[i]
    onProgress(i + 1, files.length, filename)
    const res = await fetch(entry.base + filename)
    if (!res.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${res.status}`)
    const blob = await res.blob()
    await uploadFile(targetDir, new File([blob], filename), fs)
  }
}

export async function deletePlugin(plugin: Plugin): Promise<void> {
  try {
    const result = await listFiles(`${PLUGINS_PATH}/${plugin.id}`, plugin.fs)
    for (const file of result.files.filter(f => !f.isDir)) {
      await deleteFile(`${PLUGINS_PATH}/${plugin.id}`, file.name, plugin.fs)
    }
  } catch {}
  await deleteDir(PLUGINS_PATH, plugin.id, plugin.fs)
}

export async function fetchRegistry(): Promise<StoreEntry[]> {
  const res = await fetch(STORE_REGISTRY_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data?.plugins)) throw new Error('Invalid registry format')
  return data.plugins as StoreEntry[]
}
