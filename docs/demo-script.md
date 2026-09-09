# Signal402 one minute judge demo

## Core message

Traders do not need another chart. They need an agent that connects live evidence, risk, account limits, and execution before capital moves.

This recording uses the safe live workflow. It shows real MCP context and the real Signal402 decision boundary. It does not place an order. It does not invent a receipt, balance, fill, or order ID.

## Capture rules

* Use a clean 16:9 desktop view at 1920 by 1080.
* Show only the Signal402 console, the supported MCP host, and the required terminal.
* Hide browser tabs, notifications, tokens, account identifiers, and credentials.
* Record screen video without microphone or system audio.
* Add only the synthetic narration track.
* Do not add background music or sound effects.
* Show `MCP: LIVE` only after the host supplies a real Binance tool name and timestamp.
* Show `MCP: WAITING` or `MCP: FALLBACK` when live host evidence is unavailable.

## Storyboard

| Time | Screen | Message |
| --- | --- | --- |
| 0:00 to 0:05 | Signal402 title card | Agents turn trading context into a controlled decision |
| 0:05 to 0:14 | Agent client calling capabilities and workflow | The agent discovers the contract and safety limits |
| 0:14 to 0:26 | Dashboard market panel | The host publishes live Binance context with source and timestamp |
| 0:26 to 0:37 | Briefing and access state | The Seller explains the signal; free mode has no receipt |
| 0:37 to 0:48 | Risk and approval panel | WAIT or refusal stops risk; an eligible proposal still needs APPROVE |
| 0:48 to 0:56 | Audit timeline and controls | The trader can inspect every material decision |
| 0:56 to 1:00 | Closing card | MCP, CLI, and HTTP access with strict safety boundaries |

## Voice over

Trading is not hard because a price is hidden. It is hard because the trader must connect live evidence, risk, account limits, and execution in seconds. Signal402 gives that work to two cooperating agents. The Buyer asks for a live Binance briefing. The Seller publishes the evidence, explains the signal, and applies the Risk Guardian. WAIT or a balance failure stops the trade. A valid opportunity becomes a precise proposal, but the trader keeps control through dashboard APPROVE. Only after approval can Binance receive one capped order. The console then reconciles the real order and balances. This is why traders need agents: less context switching, consistent risk rules, and an audit trail instead of guesswork. Signal402 works through MCP, CLI, and HTTP. Free access is available now. No withdrawals. No fake evidence.

## Local capture workflow

Prepare the application first:

```sh
npm run start:seller
```

Connect the supported Binance MCP host and publish one live market context. Use the safe result returned by the market. Do not change balances or market values to force a visual state.

Create the narration from the supplied text file so it is reproducible:

```sh
DEMO_DIR=/Users/teecash96/Documents/Codex/2026-09-05/you-are-an-expert-node-js/Signal402-demo
mkdir -p "$DEMO_DIR"
say -v Samantha -r 150 -f "$DEMO_DIR/signal402-demo-script.txt" -o "$DEMO_DIR/voice.aiff"
```

For a repeatable capture, serve the visual workflow page from the external demo directory:

```sh
python3 -m http.server 3314 --directory "$DEMO_DIR"
```

Open `http://localhost:3314/workflow.html` in the visible Chrome window. The page has seven fixed scenes. Set `?scene=0` through `?scene=6`, wait for the scene to settle, and capture only the page window. This avoids a timing race between the browser and the screen recorder. The captured scenes must remain truthful: the live values, `spot.ticker24hr`, source, timestamp, free access state, and balance refusal come from the recorded read only run.

Mix only the synthetic narration, add captions, and encode the final file:

```sh
ffmpeg -y -i "$DEMO_DIR/scene-sequence.mov" -i "$DEMO_DIR/voice.aiff" \
  -f srt -i "$DEMO_DIR/signal402-demo.srt" \
  -vf "scale=1920:1080:flags=lanczos" \
  -map 0:v:0 -map 1:a:0 -map 2:0 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -c:s mov_text \
  -disposition:s:0 default -t 60 \
  -movflags +faststart "$DEMO_DIR/signal402-demo.mp4"
```

The submitted video uses this settled scene sequence. It is not a static dashboard screenshot and it does not execute an order during recording.

The MP4 carries one `mov_text` caption track and the matching SRT sidecar. This keeps captions selectable in players that do not support burned in text.

Verify the deliverable:

```sh
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height \
  -of default=noprint_wrappers=1 "$DEMO_DIR/signal402-demo.mp4"
```

The final directory contains:

```text
signal402-demo.mp4
signal402-demo.srt
signal402-demo-script.txt
signal402-demo-thumbnail.png
```

## Evidence boundary

The video may show real market data, the access mode, the risk result, and the approval boundary. It must not call an order endpoint during this capture. A future live order recording requires a separate explicit approval and must show the real Binance order ID, fill, events, and before and after account state.
