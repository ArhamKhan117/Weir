# @weir/x402

Pay per request over [x402](https://www.x402.org) V2, settled through Weir's `MandateMeter` on Monad.
It defines the `weir-meter` scheme, puts a price on any Fetch-API handler, and gives clients a `fetch` that pays by itself.

## An API

```ts
import { createPaywall, weirMeter } from "@weir/x402";

const paywall = createPaywall({
  ...weirMeter(143), // the meter, its EIP-712 domain and Weir's facilitator on Monad Mainnet
  payTo: "0xYourWallet",
  asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", // USDC
  price: 1_000n, // $0.001; or a function of the request
  suggested: { periodCap: 1_000_000n, period: 86_400, maxTotal: 5_000_000n, termSeconds: 30 * 86_400 },
  description: "What one request buys",
});

export default { fetch: (request: Request) => paywall(request, handler) };
```

An unpaid request is answered `402` with the offer.
A paid one is verified with the facilitator before `handler` runs, and recorded only if the handler answers below 400, so a failed request costs nothing.
Behind a proxy that ends TLS, pass `resourceUrl` so the offer names the public address.

## A client

```ts
import { createMeterFetch } from "@weir/x402";

const pay = createMeterFetch({ signer: sessionKey, maxPrice: 10_000n });
const answer = await pay("https://api.example/quote?to=PKR");
```

The signer is the meter's payer or its manager, usually a session key, so paying needs no prompt.
It finds the signer's open meter for the API through the facilitator (or `meterFor`), refuses a price above `maxPrice` (`PriceTooHighError`) or an API it has no meter with (`NoMeterError`), and signs receipts on one meter one at a time.
After the first request to an endpoint it pays up front, so each later request is one round trip; if the offer has changed, it reads the new 402 and pays on the new terms.
The meter itself is opened by the payer's signatures, through the Weir API's `POST /v1/relay/meter`, as the app and `mm weir approve` do.

## The `weir-meter` scheme

A requirement in `accepts`:

| Field | Value |
| --- | --- |
| `scheme` | `weir-meter` |
| `network` | `eip155:143` or `eip155:10143` |
| `asset`, `payTo` | the stablecoin and the payee |
| `amount` | one request's price, in base units |
| `maxTimeoutSeconds` | how old a receipt may be |
| `extra.meter`, `extra.name`, `extra.version` | the `MandateMeter` and its EIP-712 domain |
| `extra.facilitator` | the Weir API that verifies and settles |
| `extra.suggested` | optional caps for a payer with no meter yet: `periodCap`, `period`, `maxTotal`, `termSeconds` |

The payment's `payload` is `{ meterId, total, issuedAt, signature }`: an EIP-712 `UsageReceipt(uint256 meterId,uint96 total,uint64 issuedAt)` for the running total after this request, which must be exactly the last accepted total plus the price.

Settlement is deferred: the facilitator records the receipt and answers `PAYMENT-RESPONSE` with `success`, an empty `transaction`, and `extra.total`.
Weir's settler later calls `MandateMeter.settle` with the latest receipt, which pays the difference up to both caps.

## Facilitator

Each Weir API is the facilitator for its network.

| Route | |
| --- | --- |
| `GET /v1/x402/supported` | the scheme, network, meter and the settling address |
| `POST /v1/x402/verify`, `POST /v1/x402/settle` | x402 V2 bodies; settle records the receipt |
| `GET /v1/x402/meters?signer&payTo&asset` | a key's meters for a payee |
| `GET /v1/x402/meters/:id` | a meter's state, accepted total, recent requests and settlements |

Refusals carry a reason from `METER_REASONS`, such as `weir_meter_stale_total`, `weir_meter_period_cap` or `weir_meter_unfunded`.
