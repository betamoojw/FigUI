# Motion Slider

A FigUI plugin for camera motion control rigs running FluidNC with plain cartesian kinematics:

- **X** — slide rail position (mm)
- **Y** — pan head (degrees, driven as a linear axis)
- **Z** — tilt head (degrees, driven as a linear axis)

## Features

- **Interactive 3D rig** — a fully rendered virtual slider (lighting, shadows, camera frustum, configurable colours). Three.js is bundled with the plugin, so it works on offline AP-mode controllers. Drag the carriage along the rail, the teal knob to pan, or the camera body to tilt. Empty space orbits the view, scroll/pinch zooms.
- **Live virtual → machine sync** — enable *Live jog* and dragging the model streams throttled `$J=` jog commands so the real rig follows the virtual one. The machine's actual position is shown as a green ghost rig and in the HUD readouts.
- **Position capture with millisecond timing** — capture the virtual or actual machine pose as keyframes. Each keyframe has an editable time in **ms**; the plugin converts distance ÷ time into the exact `G1 ... F` feed so every move takes precisely as long as you set. Identical poses become `G4` dwells. If a time is shorter than the machine's max rates allow, the keyframe shows a ⚠ warning and the feed is capped.
- **Run / Hold / Resume** the sequence directly, or **save it as G-code** (`/sd/motion_slider.nc`) and open it in the main viewer/job control.
- Rail travel auto-detects from `$130`; pan/tilt limits are configurable. Keyframes and settings persist on the controller via the plugin settings API.
- **Help / setup guide** — the *Help setting up* button opens a guide with an annotated sample FluidNC YAML, an explanation of machine position (MPos) vs. negative travel beyond home, and a tour of the app's features.

## Install

Copy this folder to `/plugins/` (internal) or `/sd/plugins/` and refresh the Plugins tab, or use Plugins → Add.
