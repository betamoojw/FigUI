import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, X, Pencil, Check, FileCode, FolderOpen, ChevronRight, ChevronLeft, Loader2, HardDrive, Server, Play, Square, Zap, Power, Settings, Home, Target, Crosshair, RotateCcw, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Lightbulb, Trash2, Pin } from 'lucide-react'
import { useMachineStore } from '../store'
import type { Macro, FileEntry } from '../types'
import { listFiles, fetchFileContent, saveMacroCfg, createDir, saveFileContent } from '../lib/http'
import { runMacro as runMacroCmd } from '../lib/macros'
import { CodeEditor } from './CodeEditor'
import { isGCodeFileName } from '../lib/gcodeFiles'

const COLORS = ['default', 'accent', 'ok', 'warn', 'danger', 'info', 'purple', 'teal'] as const

const BTN_CLASS: Record<Macro['color'], string> = {
  default: 'btn-ghost',
  accent:  'btn-accent-soft',
  ok:      'btn-ok',
  warn:    'btn-warn',
  danger:  'btn-danger',
  info:    'btn-info',
  purple:  'btn-purple',
  teal:    'btn-teal',
}

const DOT_BG: Record<Macro['color'], string> = {
  default: 'var(--text-muted)',
  accent:  'var(--accent)',
  ok:      'var(--ok)',
  warn:    'var(--warn)',
  danger:  'var(--danger)',
  info:    'var(--info)',
  purple:  'var(--purple)',
  teal:    'var(--teal)',
}

const ICON_MAP: Record<string, any> = {
  play: Play,
  stop: Square,
  restart: RotateCcw,
  zap: Zap,
  power: Power,
  settings: Settings,
  home: Home,
  target: Target,
  crosshair: Crosshair,
  left: ArrowLeft,
  up: ArrowUp,
  right: ArrowRight,
  down: ArrowDown,
  lightbulb: Lightbulb,
}

const GLYPH_OPTIONS = ['play','stop','restart','zap','power','settings','home','target','crosshair','left','up','right','down','lightbulb']

const getIcon = (name?: string) => {
  if (!name) return null
  const icon = ICON_MAP[name.toLowerCase()]
  return icon || null
}

const isGcode = isGCodeFileName


type BrowserFs = 'sd' | 'local'

interface FileBrowserProps {
  onSelect: (content: string, filename: string, fullPath: string, fs: BrowserFs) => void
  onClose: () => void
}

function FileBrowser({ onSelect, onClose }: FileBrowserProps) {
  const espInfo = useMachineStore(s => s.espInfo)
  const sdRoot  = espInfo?.primarySd ?? '/sd/'

  const [fs, setFs]               = useState<BrowserFs>('sd')
  const [path, setPath]           = useState(sdRoot)
  const [entries, setEntries]     = useState<FileEntry[]>([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [history, setHistory]     = useState<string[]>([])
  const [loadingFile, setLoadingFile] = useState('')

  const loadDir = useCallback(async (dir: string, filesystem: BrowserFs) => {
    setLoading(true)
    setError('')
    try {
      const result = await listFiles(dir, filesystem)
      setEntries(result.files)
      setPath(dir)
    } catch {
      setError('Could not list files')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadDir(sdRoot, 'sd') }, [loadDir, sdRoot])

  function switchFs(newFs: BrowserFs) {
    setFs(newFs)
    setHistory([])
    const root = newFs === 'sd' ? sdRoot : '/'
    loadDir(root, newFs)
  }

  function navigateTo(name: string) {
    const newPath = path === '/' ? `/${name}` : `${path.replace(/\/$/, '')}/${name}`
    setHistory(h => [...h, path])
    loadDir(newPath, fs)
  }

  function goBack() {
    if (!history.length) return
    const prev = history[history.length - 1]
    setHistory(h => h.slice(0, -1))
    loadDir(prev, fs)
  }

  async function selectEntry(entry: FileEntry) {
    if (entry.isDir) { navigateTo(entry.name); return }
    if (!isGcode(entry.name)) return
    const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`
    setLoadingFile(entry.name)
    try {
      const content = await fetchFileContent(fullPath, fs)
      onSelect(content, entry.name, fullPath, fs)
    } catch {
      setError('Failed to load file')
    } finally {
      setLoadingFile('')
    }
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-sm shadow-xl flex flex-col w-[calc(100vw-2rem)] max-w-[420px] h-[min(400px,80dvh)] animate-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Filesystem tabs */}
        <div className="flex border-b border-border shrink-0">
          {([['sd', 'SD Card', HardDrive], ['local', 'Internal', Server]] as const).map(
            ([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => switchFs(id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium
                            uppercase tracking-wide transition-colors border-b-2 -mb-px ${
                  fs === id
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-muted hover:text-text-primary'
                }`}
              >
                <Icon size={11} />{label}
              </button>
            )
          )}
          <button
            className="px-2 text-text-muted hover:text-text-primary transition-colors"
            onClick={onClose}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Path bar */}
        <div className="panel-header py-1.5 justify-between shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-text-muted
                         hover:text-text-primary disabled:opacity-30 transition-colors"
              onClick={goBack}
              disabled={!history.length}
              title="Back"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="text-sm font-mono text-text-dim truncate max-w-[240px]">{path}</span>
          </div>
          <span className="text-sm text-text-dim shrink-0">Select a G-code file</span>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center h-full gap-2 text-text-muted">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          )}
          {!loading && error && (
            <div className="text-sm text-danger text-center py-6">{error}</div>
          )}
          {!loading && !error && sorted.length === 0 && (
            <div className="text-sm text-text-dim text-center py-6">No files found</div>
          )}
          {!loading && !error && sorted.map(entry => {
            const selectable = entry.isDir || isGcode(entry.name)
            return (
              <button
                key={entry.name}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors
                            border-b border-border last:border-b-0 ${
                  entry.isDir
                    ? 'text-text-primary hover:bg-elevated'
                    : isGcode(entry.name)
                      ? 'text-accent hover:bg-accent/10'
                      : 'text-text-dim opacity-40 cursor-not-allowed'
                }`}
                onClick={() => selectable && selectEntry(entry)}
                disabled={!selectable || !!loadingFile}
              >
                {entry.isDir
                  ? <FolderOpen size={13} className="shrink-0 text-text-muted" />
                  : <FileCode size={13} className="shrink-0" />
                }
                <span className="flex-1 text-sm font-mono truncate">{entry.name}</span>
                {loadingFile === entry.name && (
                  <Loader2 size={12} className="animate-spin shrink-0 text-text-muted" />
                )}
                {!entry.isDir && isGcode(entry.name) && !loadingFile && entry.size > 0 && (
                  <span className="text-sm text-text-dim shrink-0 font-mono">
                    {entry.size < 1024
                      ? `${entry.size} B`
                      : `${(entry.size / 1024).toFixed(1)} KB`}
                  </span>
                )}
                {entry.isDir && <ChevronRight size={12} className="shrink-0 text-text-dim" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}


interface AddMenuProps {
  onBrowse: () => void
  onCreate: () => void
  onClose: () => void
}

function AddMenu({ onBrowse, onCreate, onClose }: AddMenuProps) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-sm shadow-xl w-44 py-1 animate-in">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-elevated transition-colors"
          onClick={() => { onClose(); onBrowse() }}
        >
          <FolderOpen size={12} className="shrink-0 text-text-muted" />
          Browse Files
        </button>
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-elevated transition-colors"
          onClick={() => { onClose(); onCreate() }}
        >
          <FileCode size={12} className="shrink-0 text-text-muted" />
          Create New
        </button>
      </div>
    </>
  )
}


interface MacroCardProps {
  macro: Macro
  onChange: (m: Macro) => void
  onDelete: () => void
  onOpenEditor: () => void
}

function MacroCard({ macro, onChange, onDelete, onOpenEditor }: MacroCardProps) {
  const lines = macro.command.trim().split('\n').filter(Boolean)
  const preview = lines.slice(0, 3)
  const overflow = lines.length - 3

  return (
    <div className="p-3 rounded border border-border bg-elevated/60 space-y-2.5">
      {/* Label row */}
      <div className="flex items-center gap-2">
        <input
          className="input-field flex-1 py-1 text-sm font-medium"
          value={macro.label}
          onChange={e => onChange({ ...macro, label: e.target.value })}
          placeholder="Button label"
          maxLength={20}
        />
        <button
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded
                     text-text-muted hover:text-accent hover:bg-accent/10
                     border border-transparent hover:border-accent/30 transition-colors"
          onClick={onOpenEditor}
          title="Edit in text editor"
        >
          <FileCode size={12} />
        </button>
        <button
          className={`shrink-0 w-7 h-7 flex items-center justify-center rounded
                     border transition-colors ${
            macro.pinned
              ? 'text-accent bg-accent/10 border-accent/30'
              : 'text-text-muted hover:text-accent hover:bg-accent/10 border-transparent hover:border-accent/30'
          }`}
          onClick={() => onChange({ ...macro, pinned: !macro.pinned })}
          title={macro.pinned ? 'Remove from header' : 'Pin to header'}
        >
          <Pin size={12} />
        </button>
        <button
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded
                     text-text-muted hover:text-danger hover:bg-danger/10 border border-transparent
                     hover:border-danger/30 transition-colors"
          onClick={onDelete}
          title="Delete macro"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Command preview */}
      {preview.length > 0 ? (
        <div className="bg-surface rounded px-2 py-1.5 space-y-0.5">
          {preview.map((line, i) => (
            <div key={i} className="text-sm font-mono text-text-muted truncate">{line}</div>
          ))}
          {overflow > 0 && (
            <div className="text-sm text-text-dim">
              +{overflow} more line{overflow !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      ) : macro.filename ? (
        <div className="text-sm text-text-dim italic px-1 flex items-center gap-1">
          <FileCode size={11} className="shrink-0 text-text-dim" />
          {macro.filename.split('/').pop()}
        </div>
      ) : (
        <div className="text-sm text-text-dim italic px-1">
          No command — click the edit icon to add
        </div>
      )}

      {/* Color picker */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-dim uppercase tracking-wider shrink-0">Color</span>
        <div className="flex items-center gap-1.5">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => onChange({ ...macro, color: c })}
              className={`w-5 h-5 rounded-full transition-all duration-100 ${
                macro.color === c
                  ? 'ring-2 ring-offset-1 ring-text-muted scale-110'
                  : 'opacity-50 hover:opacity-80'
              }`}
              style={{ background: DOT_BG[c] }}
              title={c}
            />
          ))}
        </div>
      </div>
      {/* Glyph selector */}
      <div>
        <span className="text-sm text-text-dim uppercase tracking-wider mb-1.5 block">Icon</span>
        <div className="grid grid-cols-7 gap-1.5">
          {GLYPH_OPTIONS.map(name => {
            const Icon = ICON_MAP[name]
            return (
              <button
                key={name}
                onClick={() => onChange({ ...macro, glyph: name })}
                className={`flex items-center justify-center p-2 rounded transition-all ${
                  macro.glyph === name
                    ? 'bg-accent/20 border border-accent text-accent'
                    : 'bg-elevated/50 border border-transparent hover:border-accent/30 text-text-muted hover:text-text-primary'
                }`}
                title={name}
              >
                {Icon && <Icon size={16} />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}


interface NamePromptProps {
  onConfirm: (name: string, color: Macro['color'], target: 'SD' | 'ESP', glyph?: string) => void
  onClose: () => void
}

function NamePrompt({ onConfirm, onClose }: NamePromptProps) {
  const [name, setName]   = useState('')
  const [color, setColor] = useState<Macro['color']>('default')
  const [target, setTarget] = useState<'SD' | 'ESP'>('ESP')
  const [glyph, setGlyph] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  function confirm() { onConfirm(name.trim() || 'New Macro', color, target, glyph) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-sm shadow-xl w-80 p-4 animate-in space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-text-primary">New Macro</p>
        <input
          ref={inputRef}
          className="input-field w-full py-1.5 text-base"
          placeholder="Macro name"
          value={name}
          maxLength={20}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') onClose() }}
        />
        {/* Color */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-dim uppercase tracking-wider shrink-0">Color</span>
          <div className="flex items-center gap-1.5">
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-5 h-5 rounded-full transition-all duration-100 ${
                  color === c ? 'ring-2 ring-offset-1 ring-text-muted scale-110' : 'opacity-50 hover:opacity-80'
                }`}
                style={{ background: DOT_BG[c] }}
                title={c}
              />
            ))}
          </div>
        </div>
        <div>
          <span className="text-sm text-text-dim uppercase tracking-wider mb-1.5 block">Save location</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={`flex items-center justify-center gap-1.5 rounded border px-3 py-2 text-sm transition-colors ${
                target === 'ESP'
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-muted hover:bg-elevated hover:text-text-primary'
              }`}
              onClick={() => setTarget('ESP')}
            >
              <Server size={13} /> Internal
            </button>
            <button
              type="button"
              className={`flex items-center justify-center gap-1.5 rounded border px-3 py-2 text-sm transition-colors ${
                target === 'SD'
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text-muted hover:bg-elevated hover:text-text-primary'
              }`}
              onClick={() => setTarget('SD')}
            >
              <HardDrive size={13} /> SD Card
            </button>
          </div>
        </div>
        {/* Glyph */}
        <div>
          <span className="text-sm text-text-dim uppercase tracking-wider mb-1.5 block">Icon</span>
          <div className="grid grid-cols-7 gap-1.5">
            {GLYPH_OPTIONS.map(g => {
              const Icon = ICON_MAP[g]
              return (
                <button
                  key={g}
                  onClick={() => setGlyph(prev => prev === g ? undefined : g)}
                  className={`flex items-center justify-center p-2 rounded transition-all ${
                    glyph === g
                      ? 'bg-accent/20 border border-accent text-accent'
                      : 'bg-elevated/50 border border-transparent hover:border-accent/30 text-text-muted hover:text-text-primary'
                  }`}
                  title={g}
                >
                  {Icon && <Icon size={16} />}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn btn-ghost text-sm py-1.5 px-3" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary text-sm py-1.5 px-3" onClick={confirm}>Open Editor</button>
        </div>
      </div>
    </div>
  )
}


interface ImportPanelProps {
  macro: Macro
  onChange: (m: Macro) => void
}

function ImportPanel({ macro, onChange }: ImportPanelProps) {
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])

  const lines   = macro.command.trim().split('\n').filter(Boolean)
  const preview = lines.slice(0, 5)
  const overflow = lines.length - 5

  return (
    <div className="flex flex-col flex-1 min-h-0 p-3 gap-3">
      {/* Name */}
      <input
        ref={nameRef}
        className="input-field w-full py-2 text-base font-medium"
        placeholder="Macro name"
        value={macro.label}
        maxLength={20}
        onChange={e => onChange({ ...macro, label: e.target.value })}
      />

      {/* Color */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-dim uppercase tracking-wider shrink-0">Color</span>
        <div className="flex items-center gap-2">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => onChange({ ...macro, color: c })}
              className={`w-5 h-5 rounded-full transition-all duration-100 ${
                macro.color === c
                  ? 'ring-2 ring-offset-1 ring-text-muted scale-110'
                  : 'opacity-50 hover:opacity-80'
              }`}
              style={{ background: DOT_BG[c] }}
              title={c}
            />
          ))}
        </div>
      </div>

      {/* Glyph */}
      <div>
        <span className="text-sm text-text-dim uppercase tracking-wider mb-1.5 block">Icon</span>
        <div className="grid grid-cols-7 gap-1.5">
          {GLYPH_OPTIONS.map(g => {
            const Icon = ICON_MAP[g]
            return (
              <button
                key={g}
                onClick={() => onChange({ ...macro, glyph: macro.glyph === g ? undefined : g })}
                className={`flex items-center justify-center p-2 rounded transition-all ${
                  macro.glyph === g
                    ? 'bg-accent/20 border border-accent text-accent'
                    : 'bg-elevated/50 border border-transparent hover:border-accent/30 text-text-muted hover:text-text-primary'
                }`}
                title={g}
              >
                {Icon && <Icon size={16} />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Read-only command preview */}
      <div className="flex-1 min-h-0 flex flex-col bg-elevated/60 rounded border border-border overflow-hidden">
        <div className="px-2 py-1 border-b border-border shrink-0">
          <span className="text-sm text-text-dim uppercase tracking-wider">
            Command preview · {lines.length} line{lines.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {preview.map((line, i) => (
            <div key={i} className="text-sm font-mono text-text-muted truncate">{line}</div>
          ))}
          {overflow > 0 && (
            <div className="text-sm text-text-dim pt-0.5">
              +{overflow} more line{overflow !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


interface MacroGridProps {
  macros: Macro[]
  isTablet: boolean
  onReorder: (macros: Macro[]) => void
}

function MacroGrid({ macros, isTablet, onReorder }: MacroGridProps) {
  const dragSrc = useRef<number>(-1)
  const [dragOver, setDragOver] = useState<number>(-1)

  function reorder(from: number, to: number) {
    if (from === to) return
    const next = [...macros]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onReorder(next)
  }

  return (
    <div className={`grid grid-cols-3 ${isTablet ? 'gap-3' : 'gap-2'}`}>
      {macros.map((m, i) => {
        const Icon = getIcon(m.glyph)
        return (
          <button
            key={m.id}
            draggable
            onDragStart={e => { dragSrc.current = i; e.dataTransfer.effectAllowed = 'move' }}
            onDragOver={e => { e.preventDefault(); setDragOver(i) }}
            onDragLeave={() => setDragOver(-1)}
            onDrop={e => { e.preventDefault(); setDragOver(-1); reorder(dragSrc.current, i) }}
            onDragEnd={() => { dragSrc.current = -1; setDragOver(-1) }}
            className={`btn ${BTN_CLASS[m.color]} flex-col gap-1.5 w-full transition-opacity ${
              isTablet ? 'min-h-[110px] py-3 text-xl' : 'min-h-[72px] py-2 text-base'
            } ${dragOver === i ? 'ring-2 ring-accent ring-offset-1 opacity-70' : ''}`}
            onClick={() => runMacroCmd(m)}
            disabled={!m.command.trim() && !m.filename}
            title={m.label || (m.filename ? 'Ready' : 'No command set')}
          >
            {Icon && <Icon size={isTablet ? 28 : 20} className="shrink-0" />}
            <span className="font-medium leading-tight text-center px-1 whitespace-normal break-words">
              {m.label || 'Unnamed'}
            </span>
          </button>
        )
      })}
    </div>
  )
}


export function Macros({ isTablet }: { isTablet?: boolean }) {
  const macros = useMachineStore(s => s.macros)
  const setMacros = useMachineStore(s => s.setMacros)
  const [editing, setEditing]             = useState(false)
  const [showAddMenu, setShowAddMenu]     = useState(false)
  const [showBrowser, setShowBrowser]     = useState(false)
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [saveError, setSaveError]         = useState(false)
  // importingMacro: dedicated panel shown after selecting a file (set name/color before saving)
  const [importingMacro, setImportingMacro] = useState<Macro | null>(null)
  // editorMacro: drives the CodeEditor modal (new scratch macros + editing existing ones)
  const [editorMacro, setEditorMacro]     = useState<Macro | null>(null)

  async function persist(updated: Macro[]) {
    setSaveError(false)
    try { await saveMacroCfg(updated) }
    catch { setSaveError(true) }
  }

  function deleteMacro(id: string) {
    const m = macros.find(m => m.id === id)
    const label = m?.label?.trim() || 'this macro'
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return
    const updated = macros.filter(m => m.id !== id)
    setMacros(updated)
    persist(updated)
  }

  // File selected from browser → dedicated import panel (name + color, then save)
  function handleFileSelect(content: string, filename: string, fullPath: string, fs: BrowserFs) {
    setShowBrowser(false)
    const id         = Date.now().toString()
    const label      = filename.replace(/\.[^.]+$/, '').slice(0, 20)
    const target     = fs === 'sd' ? 'SD' : 'ESP'
    const storedPath = fs === 'sd' ? (fullPath.replace(/^\/sd\b/, '') || '/') : fullPath
    setImportingMacro({ id, label, command: content, color: 'default', filename: storedPath, target })
  }

  // "Create New" → name prompt → CodeEditor
  function handleCreateNew() {
    setShowAddMenu(false)
    setShowNamePrompt(true)
  }

  function handleNameConfirm(label: string, color: Macro['color'], target: 'SD' | 'ESP', glyph?: string) {
    setShowNamePrompt(false)
    setEditorMacro({ id: Date.now().toString(), label, command: '', color, target, glyph })
  }

  // Save the imported macro (from file) after name/color are set
  function handleSaveImport() {
    if (!importingMacro) return
    const updated = [...macros, { ...importingMacro, label: importingMacro.label.trim() || 'New Macro' }]
    setMacros(updated)
    setImportingMacro(null)
    persist(updated)
  }

  async function openEditorForMacro(m: Macro) {
    if (m.command) {
      setEditorMacro(m)
      return
    }
    if (m.filename) {
      try {
        const fs = m.target === 'SD' ? 'sd' : 'local'
        const fullPath = m.target === 'SD' ? `/sd${m.filename}` : m.filename
        const content = await fetchFileContent(fullPath, fs)
        setEditorMacro({ ...m, command: content })
      } catch {
        setEditorMacro(m)
      }
      return
    }
    setEditorMacro(m)
  }

  // CodeEditor save — handles both new scratch macros (not in list yet) and editing existing ones
  const handleEditorSave = useCallback(async (content: string) => {
    if (!editorMacro) return
    setSaveError(false)

    try {
      const target: 'SD' | 'ESP' = editorMacro.target ?? 'ESP'
      const filesystem: BrowserFs = target === 'SD' ? 'sd' : 'local'

      // Create .macros folder if it doesn't exist
      try {
        await createDir('/', '.macros', filesystem)
      } catch {
        // Folder may already exist
      }

      let filename: string
      let filePath: string
      if (editorMacro.filename?.startsWith('/.macros/')) {
        filePath = editorMacro.filename
        filename = filePath.split('/').pop()!
      } else {
        const sanitized = (editorMacro.label || 'macro').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40)
        const timestamp = Date.now()
        filename = `${sanitized}_${timestamp}.g`
        filePath = `/.macros/${filename}`
      }

      await saveFileContent('/.macros', filename, content, filesystem)

      // Create macro entry with file reference
      const entry: Macro = {
        ...editorMacro,
        command: content,
        filename: filePath,
        target,
      }

      const updated = macros.some(m => m.id === editorMacro.id)
        ? macros.map(m => m.id === editorMacro.id ? entry : m)
        : [...macros, entry]

      setMacros(updated)
      setEditorMacro(null)
      await saveMacroCfg(updated)
    } catch (err) {
      setSaveError(true)
    }
  }, [editorMacro, macros, setMacros])

  return (
    <div className="flex flex-col h-full">

      {importingMacro ? (
        <>
          <div className="panel-header justify-between">
            <span>New Macro</span>
            <div className="flex items-center gap-1">
              <button
                className="btn btn-ghost text-sm py-0.5 px-2"
                onClick={() => setImportingMacro(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary text-sm py-0.5 px-2"
                onClick={handleSaveImport}
              >
                <Check size={11} /> Save
              </button>
            </div>
          </div>
          <ImportPanel macro={importingMacro} onChange={setImportingMacro} />
        </>
      ) : (
        <>
          <div className="panel-header justify-between">
            <span>Macros</span>
            <div className="flex items-center gap-1">
              {macros.length < 12 && (
                <div className="relative">
                  <button
                    className="w-6 h-6 flex items-center justify-center rounded
                               text-text-muted hover:text-ok hover:bg-ok/10 transition-colors"
                    onClick={() => setShowAddMenu(v => !v)}
                    title="Add macro"
                  >
                    <Plus size={13} />
                  </button>
                  {showAddMenu && (
                    <AddMenu
                      onBrowse={() => { setShowAddMenu(false); setShowBrowser(true) }}
                      onCreate={handleCreateNew}
                      onClose={() => setShowAddMenu(false)}
                    />
                  )}
                </div>
              )}
              {macros.length > 0 && (
                <button
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-sm font-medium
                              transition-colors border ${
                    editing
                      ? 'border-ok/40 bg-ok/10 text-ok hover:bg-ok/20'
                      : 'border-border text-text-muted hover:text-text-primary hover:bg-elevated'
                  }`}
                  onClick={() => {
                    if (editing) persist(macros)
                    setEditing(v => !v)
                  }}
                >
                  {editing ? <><Check size={11} /> Done</> : <><Pencil size={11} /> Edit</>}
                </button>
              )}
            </div>
          </div>

          {/* Save error banner */}
          {saveError && (
            <div className="px-3 py-1.5 bg-danger/10 border-b border-danger/30 flex items-center justify-between">
              <span className="text-sm text-danger">Failed to save to controller</span>
              <button className="text-sm text-danger underline" onClick={() => setSaveError(false)}>
                dismiss
              </button>
            </div>
          )}


          <div className="flex-1 overflow-y-auto min-h-0 p-3">
            {macros.length === 0 ? (
              /* Empty state */
              <div className="flex flex-col items-center justify-center h-full gap-4 text-text-dim">
                <div className="w-12 h-12 rounded-full bg-elevated flex items-center justify-center">
                  <FileCode size={20} className="text-text-muted" />
                </div>
                <p className="text-2xl">No macros yet</p>
                <div className="flex flex-col gap-2 items-stretch w-36">
                  <button
                    className="btn btn-ghost text-base px-3 py-1.5 gap-1.5"
                    onClick={() => setShowBrowser(true)}
                  >
                    <FolderOpen size={11} /> Browse Files
                  </button>
                  <button
                    className="btn btn-ghost text-base px-3 py-1.5 gap-1.5"
                    onClick={handleCreateNew}
                  >
                    <Plus size={11} /> Create New
                  </button>
                </div>
              </div>
            ) : editing ? (
              /* Edit mode — simple list, no drag needed here */
              <div className="space-y-2">
                {macros.map(m => (
                  <MacroCard
                    key={m.id}
                    macro={m}
                    onChange={updated => { const next = macros.map(x => x.id === updated.id ? updated : x); setMacros(next) }}
                    onDelete={() => deleteMacro(m.id)}
                    onOpenEditor={() => openEditorForMacro(m)}
                  />
                ))}
              </div>
            ) : (
              /* View mode — drag to reorder */
              <MacroGrid macros={macros} isTablet={!!isTablet} onReorder={reordered => { setMacros(reordered); persist(reordered) }} />
            )}
          </div>
        </>
      )}


      {showBrowser && (
        <FileBrowser
          onSelect={handleFileSelect}
          onClose={() => setShowBrowser(false)}
        />
      )}

      {showNamePrompt && (
        <NamePrompt
          onConfirm={handleNameConfirm}
          onClose={() => setShowNamePrompt(false)}
        />
      )}

      {editorMacro && (
        <CodeEditor
          filename={`${editorMacro.label.replace(/[^a-z0-9_-]/gi, '_') || 'macro'}.gcode`}
          content={editorMacro.command}
          onSave={handleEditorSave}
          onClose={() => setEditorMacro(null)}
        />
      )}
    </div>
  )
}
