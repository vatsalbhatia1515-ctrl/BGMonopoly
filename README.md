# BGMonopoly Prototype

Guest-login-only, real-time-ish multiplayer Monopoly room flow using a no-dependency Node.js server and client polling.

## Features implemented

- Guest login modal flow (no Google login).
- Unique usernames globally (case-insensitive).
- Profile photo upload from local files with circular center crop preview.
- Persistent guest identity per browser (`localStorage` device ID).
- Re-login with same guest identity returns same account.
- Create / join room by random code.
- Host-only pre-game settings:
  - Maximum players: 2-6
  - Starting cash: 500-3000
  - Rule toggles listed in your request
- Player list with crown for room leader.
- Host kick before game start; kicking disabled after start.
- Start game button.
- Bankrupt button (red), winner detection, auto-disband room.
- Trade request flow (send + accept/decline).

## Run

```bash
node server.js
```

Open: <http://localhost:3000>
