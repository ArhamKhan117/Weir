// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {MandateHub} from "../../src/MandateHub.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";

/// @title HubFixture
/// @notice One hub over three six-decimal assets, a payer and a manager with known keys so they
///         can sign, and term builders for a typical subscription and a typical stream.
abstract contract HubFixture is Test {
    MandateHub internal hub;
    TestStablecoin internal usd;
    TestStablecoin internal ausd;
    RefusingToken internal refusing;

    uint256 internal constant PAYER_KEY = 0xA11CE;
    uint256 internal constant MANAGER_KEY = 0x5E55;
    uint256 internal constant STRANGER_KEY = 0xBAD;

    address internal payer;
    address internal manager;
    address internal merchant;
    address internal stranger;
    address internal relayer;

    /// @dev An arbitrary, comfortably future clock so no test depends on a zero timestamp.
    uint64 internal constant T0 = 1_800_000_000;

    uint96 internal constant DOLLAR = 1e6;
    uint32 internal constant MONTH = 30 days;

    function setUp() public virtual {
        vm.warp(T0);

        usd = new TestStablecoin("Test Dollar", "TUSD");
        ausd = new TestStablecoin("Test Agora Dollar", "TAUSD");
        refusing = new RefusingToken();

        address[] memory assets = new address[](3);
        assets[0] = address(usd);
        assets[1] = address(ausd);
        assets[2] = address(refusing);
        hub = new MandateHub("Weir", "1", assets);

        payer = vm.addr(PAYER_KEY);
        manager = vm.addr(MANAGER_KEY);
        stranger = vm.addr(STRANGER_KEY);
        merchant = makeAddr("merchant");
        relayer = makeAddr("relayer");

        fund(payer, 1_000 * DOLLAR);
    }

    /*//////////////////////////////////////////////////////////////
                                  TERMS
    //////////////////////////////////////////////////////////////*/

    /// @dev $10 a month for a year, capped at twelve charges.
    function monthly() internal view returns (IMandateHub.Terms memory) {
        return IMandateHub.Terms({
            merchant: merchant,
            asset: address(usd),
            vault: address(0),
            manager: manager,
            amount: 10 * DOLLAR,
            period: MONTH,
            startAt: 0,
            maxPerCharge: 10 * DOLLAR,
            maxTotal: 120 * DOLLAR,
            expiresAt: T0 + 365 days,
            ref: bytes32("plan-basic")
        });
    }

    /// @dev $0.0001 a second, at most $5 in one charge and $50 in total, for thirty days.
    function perSecond() internal view returns (IMandateHub.Terms memory) {
        return IMandateHub.Terms({
            merchant: merchant,
            asset: address(usd),
            vault: address(0),
            manager: manager,
            amount: 100,
            period: 0,
            startAt: 0,
            maxPerCharge: 5 * DOLLAR,
            maxTotal: 50 * DOLLAR,
            expiresAt: T0 + 30 days,
            ref: bytes32("meter")
        });
    }

    /*//////////////////////////////////////////////////////////////
                                 ACTIONS
    //////////////////////////////////////////////////////////////*/

    function create(IMandateHub.Terms memory terms) internal returns (uint256) {
        vm.prank(payer);
        return hub.createMandate(terms);
    }

    /// @dev Mints `amount` of every test asset to `who` and approves the hub for all of it.
    function fund(address who, uint256 amount) internal {
        usd.mint(who, amount);
        ausd.mint(who, amount);
        refusing.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(hub), amount);
        ausd.approve(address(hub), amount);
        refusing.approve(address(hub), amount);
        vm.stopPrank();
    }

    function mandate(uint256 id) internal view returns (IMandateHub.Mandate memory) {
        return hub.getMandate(id);
    }

    /*//////////////////////////////////////////////////////////////
                                SIGNATURES
    //////////////////////////////////////////////////////////////*/

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function signCreate(uint256 key, address forPayer, IMandateHub.Terms memory terms, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return sign(key, hub.hashCreate(forPayer, terms, nonce, deadline));
    }

    function signAction(uint256 key, uint256 id, uint8 action, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return sign(key, hub.hashAction(id, action, nonce, deadline));
    }

    function signSetManager(uint256 key, uint256 id, address newManager, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return sign(key, hub.hashSetManager(id, newManager, nonce, deadline));
    }
}
