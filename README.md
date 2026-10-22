# 🌸 GestureBloom

Grow a flower bouquet in the air with your hands. Hand tracking runs live in your browser, nothing to install.

**[Try it live](https://azraanjum07.github.io/gesturebloom/)** (needs a webcam, Chrome or Edge works best)

## Gestures
| Gesture | What it does |
|---|---|
| ☝️ Point | Plants flowers along your fingertip |
| ✊ Fist | Pauses planting (nothing is erased) |
| ✋ Hold open hand | Scatters and fades the whole garden |

Two hands work at the same time.

## How it works
- **Hand tracking:** Google's MediaPipe Hand Landmarker (21 landmarks per hand), running in the browser
- **Gesture detection:** a finger counts as extended when its tip is farther from the wrist than its middle joint. A gesture only switches after a few frames agree, so it doesn't flicker
- **Flowers:** drawn in code on an HTML canvas (6 flower types, leaves, filler sprigs) and pre-rendered once as sprites
- **Performance:** finished flowers are stamped onto a permanent layer, so the cost doesn't grow with the number of flowers
- **Scatter:** each flower becomes a particle with velocity, gravity, drag and spin
- **Privacy:** the camera feed never leaves your browser

## Run locally
Serve the folder with any static server, for example `python3 -m http.server 8000`, then open `http://localhost:8000`.