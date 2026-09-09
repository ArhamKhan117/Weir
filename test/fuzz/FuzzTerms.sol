// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HubFixture} from "../helpers/HubFixture.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {MockVault} from "../mocks/MockVault.sol";

/// @title FuzzTerms
/// @notice Maps raw fuzzer output onto valid mandate terms with `bound` and deterministic
///         remapping, never by discarding runs, so every run of a suite built on it exercises the
///         property instead of being skipped. Valid terms draw from a vault whenever the raw
///         `vault` word is odd: `setUp` deploys one `MockVault` over each accepted asset, and
///         vault-backed terms name the one over their asset.
/// @dev The period limits are restated here from the specification rather than read from the
///      hub, so a change to the contract's constants shows up as a failing test.
abstract contract FuzzTerms is HubFixture {
    uint32 internal constant MIN_PERIOD = 60;
    uint32 internal constant MAX_PERIOD = 31_536_000;

    /// @dev The vault over each accepted asset.
    mapping(address asset => MockVault) internal vaultOf;

    function setUp() public virtual override {
        super.setUp();
        address[] memory assets = hub.acceptedAssets();
        for (uint256 i = 0; i < assets.length; ++i) {
            vaultOf[assets[i]] = new MockVault(IERC20(assets[i]));
        }
    }

    /// @dev Any clock from the first second to well past any realistic date, kept inside 40 bits
    ///      so every later `+ 1` on a 64-bit time stays in range.
    function _warpClock(uint256 clock) internal {
        vm.warp(bound(clock, 1, type(uint40).max));
    }

    /// @dev Valid terms of either mode for `forPayer`.
    function _validTerms(IMandateHub.Terms memory raw, address forPayer, bool streaming)
        internal
        view
        returns (IMandateHub.Terms memory)
    {
        return streaming ? _validStream(raw, forPayer) : _validPeriodic(raw, forPayer);
    }

    /// @dev A valid periodic mandate: any accepted asset drawn from the payer's balance or from
    ///      the vault over it, any manager including none, any amount, both caps at least
    ///      `amount`, any start including a past anchor, and an expiry after the current block and
    ///      not before the first charge.
    function _validPeriodic(IMandateHub.Terms memory raw, address forPayer)
        internal
        view
        returns (IMandateHub.Terms memory t)
    {
        t.merchant = _merchantFor(raw.merchant, forPayer);
        t.asset = _assetFrom(raw.asset);
        t.vault = _vaultFrom(raw.vault, t.asset);
        t.manager = raw.manager;
        t.amount = uint96(bound(raw.amount, 1, type(uint96).max));
        t.period = uint32(bound(raw.period, MIN_PERIOD, MAX_PERIOD));
        t.startAt = raw.startAt;
        t.maxPerCharge = uint96(bound(raw.maxPerCharge, t.amount, type(uint96).max));
        t.maxTotal = uint96(bound(raw.maxTotal, t.amount, type(uint96).max));

        uint256 start = t.startAt == 0 ? block.timestamp : t.startAt;
        uint256 floor = start > block.timestamp ? start : block.timestamp + 1;
        t.expiresAt = uint64(bound(raw.expiresAt, floor, type(uint64).max));
        t.ref = raw.ref;
    }

    /// @dev A valid stream: any accepted asset drawn from the payer's balance or from the vault
    ///      over it, any manager, any positive rate and caps, any start (a zero or past one is
    ///      lifted to the creation block), and an expiry strictly after the lifted start.
    function _validStream(IMandateHub.Terms memory raw, address forPayer)
        internal
        view
        returns (IMandateHub.Terms memory t)
    {
        t.merchant = _merchantFor(raw.merchant, forPayer);
        t.asset = _assetFrom(raw.asset);
        t.vault = _vaultFrom(raw.vault, t.asset);
        t.manager = raw.manager;
        t.amount = uint96(bound(raw.amount, 1, type(uint96).max));
        t.period = 0;
        t.startAt = uint64(bound(raw.startAt, 0, type(uint64).max - 1));
        t.maxPerCharge = uint96(bound(raw.maxPerCharge, 1, type(uint96).max));
        t.maxTotal = uint96(bound(raw.maxTotal, 1, type(uint96).max));

        uint256 start = t.startAt > block.timestamp ? t.startAt : block.timestamp;
        t.expiresAt = uint64(bound(raw.expiresAt, start + 1, type(uint64).max));
        t.ref = raw.ref;
    }

    /// @dev `candidate` unless it is zero, the payer, or the hub itself, in which case a
    ///      deterministic stand-in. The hub is excluded because a mandate paying the hub is not a
    ///      mandate anyone intends (see `testFuzz_hubIsNeverTheMerchant`).
    function _merchantFor(address candidate, address forPayer) internal view returns (address) {
        if (candidate == address(0) || candidate == forPayer || candidate == address(hub)) {
            candidate = address(uint160(uint256(keccak256(abi.encode("merchant", candidate, forPayer)))));
        }
        return candidate;
    }

    /// @dev One of the accepted assets, chosen by `seed`.
    function _assetFrom(address seed) internal view returns (address) {
        address[] memory assets = hub.acceptedAssets();
        return assets[uint160(seed) % assets.length];
    }

    /// @dev The vault over `asset` when `seed` is odd, else none. The fuzzer favours zero, which
    ///      keeps the plain path at least as common as the vault one.
    function _vaultFrom(address seed, address asset) internal view returns (address) {
        return uint160(seed) % 2 == 1 ? address(vaultOf[asset]) : address(0);
    }

    /// @dev A usable `msg.sender`: `candidate` unless it is zero or the hub.
    function _callerFrom(address candidate) internal view returns (address) {
        if (candidate == address(0) || candidate == address(hub)) {
            candidate = address(uint160(uint256(keccak256(abi.encode("caller", candidate)))));
        }
        return candidate;
    }
}
