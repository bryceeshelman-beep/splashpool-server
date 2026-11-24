# Try to break Splashpool

## Connection and difficulty (try these live on testnet):

- Set difficulty to 0, a negative number, or something huge
- Connect and disconnect rapidly, or reconnect in a loop
- Send malformed, oversized or nonsense messages
- Open many connections from one IP
- Connect and never log in
- Use unusual firmware or software: cgminer, bmminer, cpuminer, OSM, anything we haven't listed

## Payout edge cases (review the code and tell us if you find a flaw):

- What if the block reward is smaller than the Splash Bonus?
- What if only one miner has shares, so they're both the finder and the whole shared part?
- What if a miner joins and finds a block in its first second?
- What if shares land at the exact moment the block is found?
- Can someone game the bonus by withholding blocks or hopping between pools?

Found something? Open an issue on GitHub with your firmware, UTC time and what happened. Temporary bans are expected, and breaking it is the point.
