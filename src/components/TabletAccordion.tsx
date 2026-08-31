import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, FolderOpen, Puzzle, Sliders, Target, TerminalSquare, Wrench, Zap } from '../icons'
import { Power } from '../icons'
import { GCodeViewer } from './GCodeViewer'
import { FileManager } from './FileManager'
import { Macros } from './Macros'
import { ProbePanel } from './ProbePanel'
import { ManualATCPanel } from './ManualATCPanel'
import { Terminal } from './Terminal'
import { ProgramExecutionPanel } from './ProgramExecutionPanel'
import { OverridesPanel, SpindlePanel } from './JogPad'
import { PluginLauncher } from './PluginLauncher'
import type { Plugin } from '../types'
import { useMachineStore } from '../store'

interface TabletAccordionProps {
  tabletTab: string
  setTabletTab: (s: any) => void
  onLaunchPanel?: (plugin: Plugin) => void
}

export function TabletAccordion({ tabletTab, setTabletTab, onLaunchPanel }: TabletAccordionProps) {
  const [expanded, setExpanded] = useState<'visualizer' | 'program' | 'controls'>('visualizer')
  const [portraitTab, setPortraitTab] = useState<string>('viewer')
  const spindleMax = useMachineStore(s => s.controllerSettings.spindleMax)
  const hasSpindle = Boolean(spindleMax)
  const reportedHasProbe = useMachineStore(s => s.controllerSettings.hasProbe)
  const reportedHasToolsetter = useMachineStore(s => s.controllerSettings.hasToolsetter)
  const hasProbingInput = Boolean(reportedHasProbe || reportedHasToolsetter)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const status = useMachineStore(s => s.status)
  const isProgramRunning = (status.state === 'Run' || status.state === 'Hold')
    && (!!status.sdFilename || status.plannerLineNumber != null)

  useEffect(() => {
    if (!isProgramRunning && expanded === 'program') setExpanded('visualizer')
    if (!hasProbingInput && portraitTab === 'probing') setPortraitTab('viewer')
    if (!hasProbingInput && tabletTab === 'probing') setTabletTab('viewer')
    if (!hasManualATC && portraitTab === 'tooling') setPortraitTab('viewer')
    if (!hasManualATC && tabletTab === 'tooling') setTabletTab('viewer')
  }, [isProgramRunning, expanded, hasProbingInput, hasManualATC, portraitTab, tabletTab, setTabletTab])

  const TABS = [
    { id: 'viewer',   label: 'Viewer',   Icon: Eye },
    { id: 'files',    label: 'Files',    Icon: FolderOpen },
    { id: 'macros',   label: 'Macros',   Icon: Zap },
    ...(hasManualATC ? [{ id: 'tooling', label: 'Tooling', Icon: Wrench }] : []),
    ...(hasProbingInput ? [{ id: 'probing', label: 'Probing', Icon: Target }] : []),
    { id: 'terminal', label: 'Terminal', Icon: TerminalSquare },
    { id: 'plugins',  label: 'Plugins',  Icon: Puzzle },
  ]

  const PORTRAIT_TABS = [
    { id: 'viewer',    label: 'Viewer',    Icon: Eye },
    { id: 'files',     label: 'Files',     Icon: FolderOpen },
    { id: 'macros',    label: 'Macros',    Icon: Zap },
    ...(hasManualATC ? [{ id: 'tooling', label: 'Tooling', Icon: Wrench }] : []),
    ...(hasProbingInput ? [{ id: 'probing', label: 'Probing', Icon: Target }] : []),
    { id: 'terminal',  label: 'Terminal',  Icon: TerminalSquare },
    ...(hasSpindle ? [{ id: 'spindle', label: 'Spindle', Icon: Power }] : []),
    { id: 'overrides', label: 'Overrides', Icon: Sliders },
    { id: 'plugins',   label: 'Plugins',   Icon: Puzzle },
  ]

  return (
    <div className="portrait:shrink-0 landscape:flex-1 landscape:basis-1/2 landscape:min-h-0 landscape:overflow-hidden flex flex-col">

      {/* ═══ PORTRAIT LAYOUT: tabbed panel → Viewer at bottom ═══ */}
      <div className="portrait:flex landscape:hidden flex-col gap-3">

        {isProgramRunning && <ProgramExecutionPanel isTablet />}

        {/* All-in-one tab panel */}
        <div className="panel flex flex-col">
          <div className="flex w-full border-b border-border shrink-0">
            {PORTRAIT_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setPortraitTab(id)}
                className={`min-w-0 flex-1 px-1 py-2 text-[clamp(10px,2.2vw,20px)] font-medium uppercase tracking-wide whitespace-nowrap transition-colors border-b-2 -mb-px flex flex-col items-center justify-center gap-0.5 ${
                  portraitTab === id
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-muted hover:text-text-primary'
                }`}
              >
                <Icon size={15} className="shrink-0" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="min-h-[420px] overflow-hidden">
            {portraitTab === 'viewer'    && (
              <div className="flex flex-col gap-3 p-3">
                <GCodeViewer className="min-h-[55vh]" isTablet />
              </div>
            )}
            {portraitTab === 'files'     && <FileManager isTablet />}
            {portraitTab === 'macros'    && <Macros isTablet />}
            {portraitTab === 'tooling' && hasManualATC && <div className="p-3"><ManualATCPanel isTablet embedded /></div>}
            {portraitTab === 'probing' && hasProbingInput && <div className="p-3"><ProbePanel isTablet embedded /></div>}
            {portraitTab === 'terminal'  && <Terminal />}
            {portraitTab === 'spindle' && hasSpindle && (
              <div className="p-5">
                <SpindlePanel className="border-none shadow-none p-0" isTablet />
              </div>
            )}
            {portraitTab === 'overrides' && (
              <div className="p-5">
                <OverridesPanel className="border-none shadow-none p-0" isTablet />
              </div>
            )}
            {portraitTab === 'plugins'   && <PluginLauncher isTablet onLaunchPanel={onLaunchPanel} activeLayout="tablet" />}
          </div>
        </div>

      </div>

      {/* ═══ LANDSCAPE LAYOUT: accordion unchanged ═══ */}
      <div className="landscape:flex portrait:hidden flex-col gap-3 flex-1 min-h-0 overflow-hidden">

        {/* Visualizer / tabs panel */}
        <div className={`panel flex flex-col transition-all duration-300 ${expanded === 'visualizer' ? 'flex-1 min-h-0' : 'shrink-0'}`}>
          {expanded !== 'visualizer' && (
            <button
              className="panel-header text-left font-bold cursor-pointer flex justify-between items-center text-xl py-4"
              onClick={() => setExpanded('visualizer')}
            >
              <span>{TABS.find(t => t.id === tabletTab)?.label}</span>
              <ChevronRight size={22} />
            </button>
          )}
          {expanded === 'visualizer' && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex w-full border-b border-border shrink-0">
                {TABS.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTabletTab(id)}
                    className={`min-w-0 flex-1 px-1 py-2 text-[clamp(10px,1.35vw,20px)] font-medium uppercase tracking-wide whitespace-nowrap transition-colors border-b-2 -mb-px flex flex-col items-center justify-center gap-0.5 ${
                      tabletTab === id
                        ? 'border-accent text-accent'
                        : 'border-transparent text-text-muted hover:text-text-primary'
                    }`}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span>{label}</span>
                  </button>
                ))}
                <button onClick={() => setExpanded('controls')} className="w-11 shrink-0 hover:text-text-primary text-text-muted flex items-center justify-center">
                  <ChevronDown size={22} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <div className={`h-full flex flex-col gap-3 p-3 overflow-y-auto ${tabletTab !== 'viewer' ? 'hidden' : ''}`}>
                  <GCodeViewer className="flex-1 min-h-[300px]" isTablet fitToViewSignal={expanded === 'visualizer'} />
                </div>
                {tabletTab === 'files'    && <FileManager isTablet />}
                {tabletTab === 'macros'   && <Macros isTablet />}
                {tabletTab === 'tooling' && hasManualATC && <div className="h-full overflow-y-auto p-3"><ManualATCPanel isTablet embedded /></div>}
                {tabletTab === 'probing' && hasProbingInput && <div className="h-full overflow-y-auto p-3"><ProbePanel isTablet embedded /></div>}
                {tabletTab === 'terminal' && <Terminal />}
                {tabletTab === 'plugins'  && <PluginLauncher isTablet onLaunchPanel={onLaunchPanel} activeLayout="tablet" />}
              </div>
            </div>
          )}
        </div>

        {isProgramRunning && (
          <div className={`panel flex flex-col transition-all duration-300 ${expanded === 'program' ? 'flex-1 min-h-0' : 'shrink-0'}`}>
            {expanded !== 'program' ? (
              <button
                className="panel-header text-left font-bold cursor-pointer flex justify-between items-center text-xl py-4"
                onClick={() => setExpanded('program')}
              >
                <span className="uppercase tracking-wide">Program execution</span>
                <ChevronRight size={22} />
              </button>
            ) : (
              <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <button
                  className="panel-header flex justify-between items-center border-b border-border cursor-pointer hover:text-text-primary shrink-0 text-xl py-3"
                  onClick={() => setExpanded('visualizer')}
                >
                  <span className="uppercase tracking-wide">Program execution</span>
                  <ChevronDown size={22} />
                </button>
                <ProgramExecutionPanel isTablet accordionManaged />
              </div>
            )}
          </div>
        )}

        {/* Controls (Spindle & Overrides) panel */}
        <div className={`panel flex flex-col transition-all duration-300 ${expanded === 'controls' ? 'flex-1 min-h-0 overflow-y-auto' : 'shrink-0'}`}>
          {expanded !== 'controls' && (
            <button
              className="panel-header text-left font-bold cursor-pointer flex justify-between items-center text-xl py-4"
              onClick={() => setExpanded('controls')}
            >
              <span className="uppercase tracking-wide">{hasSpindle ? 'Spindle & Overrides' : 'Overrides'}</span>
              <ChevronRight size={22} />
            </button>
          )}
          {expanded === 'controls' && (
            <div className="flex flex-col flex-1 min-h-0">
              <button
                className="panel-header flex justify-between items-center border-b border-border cursor-pointer hover:text-text-primary shrink-0 text-xl py-3"
                onClick={() => setExpanded('visualizer')}
              >
                <span className="uppercase tracking-wide">{hasSpindle ? 'Spindle & Overrides' : 'Overrides'}</span>
                <ChevronDown size={22} />
              </button>
              <div className="flex-1 overflow-y-auto flex flex-col gap-0 p-0">
                {hasSpindle && <>
                  <SpindlePanel className="border-none shadow-none p-0" isTablet />
                  <div className="h-px bg-border w-full my-1" />
                </>}
                <OverridesPanel className="border-none shadow-none p-0" isTablet />
              </div>
            </div>
          )}
        </div>

      </div>

    </div>
  )
}
