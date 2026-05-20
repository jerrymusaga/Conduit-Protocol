// Runs before any test module imports config.ts. Provides a valid env so
// startup validation passes without process.exit.
process.env.PORT ??= "4500";
process.env.CHAIN_ID ??= "84532";
process.env.FACILITATOR_URL ??= "http://localhost:4400";
process.env.PAY_TO ??= "0x51A4FDB15787bd43FE3C96c49e559526B637bC66";
process.env.PRICE_USDC ??= "0.01";
