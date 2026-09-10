// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {MockSmartWallet} from "../mocks/MockSmartWallet.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {FuzzTerms} from "./FuzzTerms.sol";

/// @dev Answers every call, `asset()` included, with empty return data, the way a contract with
///      an empty fallback (a bare multisig, say) does.
contract SilentFallback {
    fallback() external {}
}

/// @dev Answers `asset()` with a word that is not an address: `dirt` in the high bits over the
///      given token in the low ones.
contract DirtyAssetAnswer {
    uint256 internal immutable _word;

    constructor(address token, uint96 dirt) {
        _word = uint256(dirt) << 160 | uint160(token);
    }

    function asset() external view returns (uint256) {
        return _word;
    }
}

/// @title MandateHubCreateFuzzTest
/// @notice Creation is exact and all-or-nothing. Any valid terms, periodic or streaming, create
///         exactly one mandate under the next id that stores precisely what was given: a periodic
///         past start is kept as the schedule anchor, and a stream's zero or past start is lifted
///         to the creation block. A mandate drawn from a vault stores and emits the vault, and a
///         vault that is not an ERC-4626 vault over the mandate's asset (one over another token,
///         an address with no code, any other contract) is refused with `InvalidVault`. Each class
///         of invalid input reverts with its own error and leaves `nextMandateId`, every stored
///         record, every balance and every vault position unchanged.
contract MandateHubCreateFuzzTest is FuzzTerms {
    /// @dev A mandate that exists before every test, so "nothing changed" also covers a
    ///      neighbouring record.
    uint256 internal existingId;

    function setUp() public override {
        super.setUp();
        existingId = create(monthly());
    }

    /*//////////////////////////////////////////////////////////////
                              VALID TERMS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_periodicStoresExactTerms(IMandateHub.Terms memory raw, uint256 clock) public {
        _warpClock(clock);
        IMandateHub.Terms memory t = _validPeriodic(raw, payer);

        uint64 start = t.startAt == 0 ? uint64(block.timestamp) : t.startAt;
        _assertCreatesExactly(payer, t, start);
    }

    function testFuzz_streamStoresExactTermsWithPastStartLifted(IMandateHub.Terms memory raw, uint256 clock) public {
        _warpClock(clock);
        IMandateHub.Terms memory t = _validStream(raw, payer);

        // Zero, past and present all mean "now" for a stream; only a future start is kept.
        uint64 start = t.startAt > block.timestamp ? t.startAt : uint64(block.timestamp);
        _assertCreatesExactly(payer, t, start);
    }

    function testFuzz_idsAreSequentialAcrossPayers(address[5] memory payers, IMandateHub.Terms memory raw) public {
        uint256 first = hub.nextMandateId();

        for (uint256 i = 0; i < payers.length; ++i) {
            address who = _callerFrom(payers[i]);
            IMandateHub.Terms memory t = _validTerms(raw, who, i % 2 == 1);

            vm.prank(who);
            assertEq(hub.createMandate(t), first + i, "ids are handed out in order");
            assertEq(hub.getMandate(first + i).payer, who, "the id belongs to its creator");
        }

        assertEq(hub.nextMandateId(), first + payers.length, "one id per creation");
        assertEq(hub.getMandate(first + payers.length).payer, address(0), "no record beyond the last id");
    }

    /*//////////////////////////////////////////////////////////////
                             INVALID TERMS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_revertsOnUnacceptedAsset(IMandateHub.Terms memory raw, bool streaming, address asset) public {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        while (hub.isAcceptedAsset(asset)) {
            asset = address(uint160(uint256(keccak256(abi.encode(asset)))));
        }
        t.asset = asset;

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidAsset.selector, asset));
    }

    function testFuzz_revertsOnZeroMerchant(IMandateHub.Terms memory raw, bool streaming) public {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.merchant = address(0);

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidMerchant.selector));
    }

    function testFuzz_revertsWhenMerchantIsPayer(IMandateHub.Terms memory raw, bool streaming, address who) public {
        who = _callerFrom(who);
        IMandateHub.Terms memory t = _validTerms(raw, who, streaming);
        t.merchant = who;

        _assertRejected(who, t, abi.encodeWithSelector(IMandateHub.InvalidMerchant.selector));
    }

    function testFuzz_revertsOnZeroAmount(IMandateHub.Terms memory raw, bool streaming) public {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.amount = 0;

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidAmount.selector));
    }

    function testFuzz_revertsOnPeriodBelowMinimum(IMandateHub.Terms memory raw, uint32 period) public {
        IMandateHub.Terms memory t = _validPeriodic(raw, payer);
        t.period = uint32(bound(period, 1, MIN_PERIOD - 1));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidPeriod.selector));
    }

    function testFuzz_revertsOnPeriodAboveMaximum(IMandateHub.Terms memory raw, uint32 period) public {
        IMandateHub.Terms memory t = _validPeriodic(raw, payer);
        t.period = uint32(bound(period, uint256(MAX_PERIOD) + 1, type(uint32).max));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidPeriod.selector));
    }

    function testFuzz_revertsOnZeroChargeCap(IMandateHub.Terms memory raw, bool streaming) public {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.maxPerCharge = 0;

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidChargeCap.selector));
    }

    function testFuzz_revertsOnPeriodicChargeCapBelowAmount(IMandateHub.Terms memory raw, uint96 cap) public {
        IMandateHub.Terms memory t = _validPeriodic(raw, payer);
        t.amount = uint96(bound(t.amount, 2, type(uint96).max));
        if (t.maxTotal < t.amount) t.maxTotal = t.amount;
        t.maxPerCharge = uint96(bound(cap, 1, t.amount - 1));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidChargeCap.selector));
    }

    function testFuzz_revertsOnZeroTotalCap(IMandateHub.Terms memory raw, bool streaming) public {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.maxTotal = 0;

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidTotalCap.selector));
    }

    function testFuzz_revertsOnPeriodicTotalCapBelowAmount(IMandateHub.Terms memory raw, uint96 cap) public {
        IMandateHub.Terms memory t = _validPeriodic(raw, payer);
        t.amount = uint96(bound(t.amount, 2, type(uint96).max));
        if (t.maxPerCharge < t.amount) t.maxPerCharge = t.amount;
        t.maxTotal = uint96(bound(cap, 1, t.amount - 1));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidTotalCap.selector));
    }

    function testFuzz_revertsOnExpiryNotAfterNow(IMandateHub.Terms memory raw, bool streaming, uint64 expiresAt)
        public
    {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.expiresAt = uint64(bound(expiresAt, 0, block.timestamp));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidExpiry.selector));
    }

    function testFuzz_revertsOnExpiryBeforePeriodicStart(IMandateHub.Terms memory raw, uint64 startAt, uint64 expiresAt)
        public
    {
        IMandateHub.Terms memory t = _validPeriodic(raw, payer);
        t.startAt = uint64(bound(startAt, block.timestamp + 2, type(uint64).max));
        t.expiresAt = uint64(bound(expiresAt, block.timestamp + 1, t.startAt - 1));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidExpiry.selector));
    }

    function testFuzz_revertsOnStreamExpiryNotAfterStart(IMandateHub.Terms memory raw, uint64 startAt, uint64 expiresAt)
        public
    {
        IMandateHub.Terms memory t = _validStream(raw, payer);
        t.startAt = uint64(bound(startAt, block.timestamp + 1, type(uint64).max));
        t.expiresAt = uint64(bound(expiresAt, block.timestamp + 1, t.startAt));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidExpiry.selector));
    }

    /*//////////////////////////////////////////////////////////////
                                 VAULTS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_vaultBackedStoresAndEmitsTheVault(IMandateHub.Terms memory raw, bool streaming, uint256 clock)
        public
    {
        _warpClock(clock);
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.vault = address(vaultOf[t.asset]);

        _assertCreatesExactly(payer, t, _startOf(t));
    }

    /// @dev A real ERC-4626 vault, over another accepted asset or over a token the hub does not
    ///      accept at all.
    function testFuzz_revertsOnVaultOverAnotherAsset(IMandateHub.Terms memory raw, bool streaming, uint256 which)
        public
    {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        address[] memory assets = hub.acceptedAssets();
        uint256 pick = which % (assets.length + 1);
        if (pick == assets.length) {
            t.vault = address(new MockVault(new TestStablecoin("Unaccepted Dollar", "XUSD")));
        } else {
            if (assets[pick] == t.asset) pick = (pick + 1) % assets.length;
            t.vault = address(vaultOf[assets[pick]]);
        }

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidVault.selector, t.vault));
    }

    function testFuzz_revertsOnVaultWithNoCode(IMandateHub.Terms memory raw, bool streaming, address candidate) public {
        while (candidate == address(0) || candidate.code.length != 0) {
            candidate = address(uint160(uint256(keccak256(abi.encode("no code", candidate)))));
        }
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.vault = candidate;

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidVault.selector, candidate));
    }

    /// @dev Contracts that do not implement `asset()` at all: any accepted token (the mandate's own
    ///      asset included), the hub itself, and a smart wallet.
    function testFuzz_revertsOnContractThatIsNotAVault(IMandateHub.Terms memory raw, bool streaming, uint256 which)
        public
    {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        address[] memory assets = hub.acceptedAssets();
        uint256 pick = which % (assets.length + 2);
        if (pick < assets.length) t.vault = assets[pick];
        else if (pick == assets.length) t.vault = address(hub);
        else t.vault = address(new MockSmartWallet(payer));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidVault.selector, t.vault));
    }

    /*//////////////////////////////////////////////////////////////
                              SUSPECTED BUG
    //////////////////////////////////////////////////////////////*/

    /// @dev SUSPECTED BUG, fails today. `_isVaultOver` wraps `asset()` in a try/catch, but a
    ///      try/catch only catches a revert inside the call: when the call succeeds and its return
    ///      data does not decode as an address (empty, as from a contract with an empty fallback,
    ///      or a word with dirty high bits), the decoding reverts in the hub itself, uncaught.
    ///      Creation then fails with empty revert data instead of `InvalidVault(vault)`, which the
    ///      terms promise "unless the vault has code and `asset()` returns the mandate asset". The
    ///      creation is still refused, so no funds are at risk; a wallet or relayer cannot tell
    ///      the payer why.
    function testFuzz_malformedAssetAnswerIsAnInvalidVault(
        IMandateHub.Terms memory raw,
        bool streaming,
        bool silent,
        uint96 dirt
    ) public {
        IMandateHub.Terms memory t = _validTerms(raw, payer, streaming);
        t.vault = silent
            ? address(new SilentFallback())
            : address(new DirtyAssetAnswer(t.asset, uint96(bound(dirt, 1, type(uint96).max))));

        _assertRejected(payer, t, abi.encodeWithSelector(IMandateHub.InvalidVault.selector, t.vault));
    }

    /// @dev SUSPECTED BUG, fails today. `_create` refuses a zero merchant and the payer as its own
    ///      merchant, but not the hub. A mandate naming the hub as merchant is created, and its
    ///      first charge moves the payer's money into the hub, which has no function that can ever
    ///      pay it out. That breaks the documented property that the hub never holds a balance.
    ///      The test accepts either shape of fix: creation rejected with `InvalidMerchant`, or no
    ///      balance ever reaching the hub.
    function testFuzz_hubIsNeverTheMerchant(uint96 amount) public {
        IMandateHub.Terms memory t = monthly();
        t.merchant = address(hub);
        t.amount = uint96(bound(amount, 1, 10 * DOLLAR));
        t.maxPerCharge = t.amount;
        t.maxTotal = t.amount * 12;

        vm.prank(payer);
        try hub.createMandate(t) returns (uint256 id) {
            hub.charge(id);
            assertEq(usd.balanceOf(address(hub)), 0, "the hub took custody of funds it can never release");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(IMandateHub.InvalidMerchant.selector), "rejected as a merchant");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The start the hub must record: a zero start is now, and a stream lifts a past one.
    function _startOf(IMandateHub.Terms memory t) internal view returns (uint64 start) {
        start = t.startAt == 0 ? uint64(block.timestamp) : t.startAt;
        if (t.period == 0 && start < block.timestamp) start = uint64(block.timestamp);
    }

    function _assertCreatesExactly(address who, IMandateHub.Terms memory t, uint64 start) internal {
        uint256 expectedId = hub.nextMandateId();
        bytes memory fundsBefore = _funds();
        bytes memory neighbourBefore = abi.encode(hub.getMandate(existingId));

        vm.recordLogs();
        vm.prank(who);
        uint256 id = hub.createMandate(t);

        assertEq(id, expectedId, "returns the next id");
        assertEq(hub.nextMandateId(), expectedId + 1, "consumes exactly one id");
        _assertStored(id, who, t, start);
        _assertCreatedEvent(id, who, t, start);
        assertEq(_funds(), fundsBefore, "creation moves no funds");
        assertEq(abi.encode(hub.getMandate(existingId)), neighbourBefore, "other records untouched");
    }

    function _assertStored(uint256 id, address who, IMandateHub.Terms memory t, uint64 start) internal view {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        assertEq(m.payer, who, "payer");
        assertEq(m.nextChargeAt, start, "nextChargeAt");
        assertEq(m.period, t.period, "period");
        assertEq(m.merchant, t.merchant, "merchant");
        assertEq(m.expiresAt, t.expiresAt, "expiresAt");
        assertEq(uint8(m.status), uint8(IMandateHub.Status.Active), "status");
        assertEq(m.asset, t.asset, "asset");
        assertEq(m.amount, t.amount, "amount");
        assertEq(m.manager, t.manager, "manager");
        assertEq(m.maxPerCharge, t.maxPerCharge, "maxPerCharge");
        assertEq(m.maxTotal, t.maxTotal, "maxTotal");
        assertEq(m.totalCharged, 0, "totalCharged");
        assertEq(m.pausedAt, 0, "pausedAt");
        assertEq(m.vault, t.vault, "vault");
    }

    /// @dev Creation emits exactly one log, `MandateCreated`, carrying every agreed term.
    function _assertCreatedEvent(uint256 id, address who, IMandateHub.Terms memory t, uint64 start) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");

        Vm.Log memory log = logs[0];
        assertEq(log.emitter, address(hub), "emitter");
        assertEq(log.topics.length, 4, "three indexed fields");
        assertEq(log.topics[0], IMandateHub.MandateCreated.selector, "event");
        assertEq(uint256(log.topics[1]), id, "indexed id");
        assertEq(address(uint160(uint256(log.topics[2]))), who, "indexed payer");
        assertEq(address(uint160(uint256(log.topics[3]))), t.merchant, "indexed merchant");
        assertEq(
            log.data,
            bytes.concat(
                abi.encode(t.asset, t.vault, t.manager, t.amount, t.period, start),
                abi.encode(t.maxPerCharge, t.maxTotal, t.expiresAt, t.ref)
            ),
            "terms in the event"
        );
    }

    function _assertRejected(address from, IMandateHub.Terms memory t, bytes memory err) internal {
        bytes memory before = _state();

        vm.prank(from);
        vm.expectRevert(err);
        hub.createMandate(t);

        assertEq(_state(), before, "a rejected creation changed state");
    }

    /// @dev The id counter, the neighbouring record, the slot the next id would fill, and funds.
    function _state() internal view returns (bytes memory) {
        uint256 next = hub.nextMandateId();
        return bytes.concat(
            abi.encode(next, hub.getMandate(existingId), hub.getMandate(next), hub.getMandate(next + 1)), _funds()
        );
    }

    /// @dev Supply, and the balances and hub allowances of the payer, the merchant, the hub and
    ///      the vault over it, of every asset and of every vault's shares.
    function _funds() internal view returns (bytes memory s) {
        address[] memory assets = hub.acceptedAssets();
        for (uint256 i = 0; i < assets.length; ++i) {
            MockVault vault = vaultOf[assets[i]];
            s = bytes.concat(s, _holdings(IERC20(assets[i]), vault), _holdings(vault, vault));
        }
    }

    function _holdings(IERC20 token, MockVault vault) internal view returns (bytes memory s) {
        address[4] memory who = [payer, merchant, address(hub), address(vault)];
        s = abi.encode(token.totalSupply());
        for (uint256 j = 0; j < who.length; ++j) {
            s = bytes.concat(s, abi.encode(token.balanceOf(who[j]), token.allowance(who[j], address(hub))));
        }
    }
}
