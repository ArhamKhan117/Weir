// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {MandateMeter} from "../../../src/MandateMeter.sol";
import {IMandateMeter} from "../../../src/interfaces/IMandateMeter.sol";
import {TestStablecoin} from "../../../src/testnet/TestStablecoin.sol";

/// @title MandateMeterHandler
/// @notice Drives a few meters through random receipts, settlements, clock jumps, cancellations
///         and funding gaps, keeping ghost totals the invariants compare against.
contract MandateMeterHandler is Test {
    MandateMeter public immutable meter;
    TestStablecoin public immutable usd;

    uint256 internal constant PAYER_KEY = 0xA11CE;
    uint256 internal constant MANAGER_KEY = 0x5E55;
    address public immutable payer;

    uint256[] public ids;
    mapping(uint256 id => address) public merchantOf;

    /// @dev The highest total either key ever signed for a meter.
    mapping(uint256 id => uint96) public highestSigned;
    /// @dev What was paid in each period, by its start time.
    mapping(uint256 id => mapping(uint64 periodStart => uint256)) public paidInPeriod;
    mapping(uint256 id => uint64[]) internal _periods;

    uint256 public settlements;
    uint256 public shortfalls;

    constructor(MandateMeter meter_, TestStablecoin usd_) {
        meter = meter_;
        usd = usd_;
        payer = vm.addr(PAYER_KEY);

        usd.mint(payer, 10_000e6);
        vm.prank(payer);
        usd.approve(address(meter), type(uint256).max);

        uint32[3] memory periods = [uint32(60), uint32(1 hours), uint32(1 days)];
        for (uint256 i = 0; i < 3; ++i) {
            address merchant = makeAddr(string.concat("merchant", vm.toString(i)));
            IMandateMeter.Terms memory t = IMandateMeter.Terms({
                merchant: merchant,
                asset: address(usd),
                manager: vm.addr(MANAGER_KEY),
                periodCap: uint96(5e6 * (i + 1)),
                period: periods[i],
                maxTotal: uint96(40e6 * (i + 1)),
                expiresAt: uint64(block.timestamp + 20 days),
                ref: bytes32(i)
            });
            vm.prank(payer);
            uint256 id = meter.createMeter(t);
            ids.push(id);
            merchantOf[id] = merchant;
        }
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function periodsOf(uint256 id) external view returns (uint64[] memory) {
        return _periods[id];
    }

    /// @notice Signs a receipt somewhere around the current total and settles it.
    function settle(uint256 which, uint256 delta, bool byPayer, uint256 lag) external {
        uint256 id = ids[which % ids.length];
        IMandateMeter.Meter memory m = meter.getMeter(id);

        // Usually above what is paid, sometimes at or below it (a stale receipt).
        uint256 ahead = bound(delta, 0, 30e6);
        uint256 behind = bound(lag, 0, 2e6) / 4;
        uint256 raw = uint256(m.totalCharged) + ahead;
        uint96 total = uint96(raw > behind ? raw - behind : 0);
        uint64 issuedAt = uint64(block.timestamp);
        if (m.closedAt != 0 && issuedAt > m.closedAt) issuedAt = m.closedAt;
        if (issuedAt > m.expiresAt) issuedAt = m.expiresAt;

        IMandateMeter.Receipt memory r = IMandateMeter.Receipt({meterId: id, total: total, issuedAt: issuedAt});
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(byPayer ? PAYER_KEY : MANAGER_KEY, meter.hashReceipt(r));
        if (total > highestSigned[id]) highestSigned[id] = total;

        try meter.settle(r, abi.encodePacked(rr, s, v)) returns (uint256 amount) {
            if (amount == 0) {
                ++shortfalls;
                return;
            }
            ++settlements;
            uint64 start = meter.getMeter(id).periodStart;
            if (paidInPeriod[id][start] == 0) _periods[id].push(start);
            paidInPeriod[id][start] += amount;
        } catch {}
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 days));
    }

    function cancel(uint256 which, uint256 who) external {
        uint256 id = ids[which % ids.length];
        address[3] memory by = [payer, vm.addr(MANAGER_KEY), merchantOf[id]];
        vm.prank(by[who % 3]);
        try meter.cancel(id) {} catch {}
    }

    /// @notice Takes the payer's money away for a while, or gives it back.
    function drain(bool empty) external {
        if (empty) {
            uint256 balance = usd.balanceOf(payer);
            vm.prank(payer);
            usd.transfer(address(0xdead), balance);
        } else {
            usd.mint(payer, 1_000e6);
        }
    }
}
