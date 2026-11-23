# Uno-arena

Multiplayer UNO Arena.

## Run locally
```bash
npm install
npm start
```
Then open http://localhost:3000

## Backend
Node.js + Express + Socket.IO server in `server.js`. Deploy manually (do not use Vercel).

## Database
Run `supabase/migrations/20261121000000_rewarded_ads.sql` in the Supabase SQL editor to enable rewarded ads (20 coins, 5 per day).
