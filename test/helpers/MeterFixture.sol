// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {MandateMeter} from "../../src/MandateMeter.sol";
import {IMandateMeter} from "../../src/interfaces/IMandateMeter.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";

/// @title MeterFixture
/// @notice One meter over two six-decimal assets and a refusing one, a payer and a manager with
///         known keys, and a typical pay-per-call authorization.
abstract contract MeterFixture is Test {
    MandateMeter internal meter;
    TestStablecoin internal usd;
    TestStablecoin internal ausd;
    RefusingToken internal refusing;

    uint256 internal constant PAYER_KEY = 0xA11CE;
    uint256 internal constant MANAGER_KEY = 0x5E55;
    uint256 internal constant STRANGER_KEY = 0xBAD;
    uint256 internal constant MERCHANT_KEY = 0xC0FFEE;

    address internal payer;
    address internal manager;
    address internal merchant;
    address internal stranger;
    address internal relayer;

    uint64 internal constant T0 = 1_800_000_000;
    uint96 internal constant DOLLAR = 1e6;
    uint96 internal constant CENT = 1e4;
    uint32 internal constant DAY = 1 days;

    function setUp() public virtual {
        vm.warp(T0);

        usd = new TestStablecoin("Test Dollar", "TUSD");
        ausd = new TestStablecoin("Test Agora Dollar", "TAUSD");
        refusing = new RefusingToken();

        address[] memory assets = new address[](3);
        assets[0] = address(usd);
        assets[1] = address(ausd);
        assets[2] = address(refusing);
        meter = new MandateMeter("Weir", "1", assets);

        payer = vm.addr(PAYER_KEY);
        manager = vm.addr(MANAGER_KEY);
        stranger = vm.addr(STRANGER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        relayer = makeAddr("relayer");

        fund(payer, 1_000 * DOLLAR);
    }

    /// @dev Up to $5 a day and $20 in all, for thirty days, receipts signed by the manager.
    function perCall() internal view returns (IMandateMeter.Terms memory) {
        return IMandateMeter.Terms({
            merchant: merchant,
            asset: address(usd),
            manager: manager,
            periodCap: 5 * DOLLAR,
            period: DAY,
            maxTotal: 20 * DOLLAR,
            expiresAt: T0 + 30 days,
            ref: bytes32("api-plan")
        });
    }

    function open(IMandateMeter.Terms memory terms) internal returns (uint256) {
        vm.prank(payer);
        return meter.createMeter(terms);
    }

    /// @dev Mints `amount` of every test asset to `who` and approves the meter for all of it.
    function fund(address who, uint256 amount) internal {
        usd.mint(who, amount);
        ausd.mint(who, amount);
        refusing.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(meter), amount);
        ausd.approve(address(meter), amount);
        refusing.approve(address(meter), amount);
        vm.stopPrank();
    }

    function state(uint256 id) internal view returns (IMandateMeter.Meter memory) {
        return meter.getMeter(id);
    }

    function receipt(uint256 id, uint96 total) internal view returns (IMandateMeter.Receipt memory) {
        return IMandateMeter.Receipt({meterId: id, total: total, issuedAt: uint64(block.timestamp)});
    }

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function signReceipt(uint256 key, IMandateMeter.Receipt memory r) internal view returns (bytes memory) {
        return sign(key, meter.hashReceipt(r));
    }

    /// @dev Signs `total` with the manager key and settles it as the relayer.
    function settleAs(uint256 key, uint256 id, uint96 total) internal returns (uint256) {
        IMandateMeter.Receipt memory r = receipt(id, total);
        bytes memory sig = signReceipt(key, r);
        vm.prank(relayer);
        return meter.settle(r, sig);
    }

    function settle(uint256 id, uint96 total) internal returns (uint256) {
        return settleAs(MANAGER_KEY, id, total);
    }
}
