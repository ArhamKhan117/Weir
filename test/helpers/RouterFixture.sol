// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SavingsRouter} from "../../src/SavingsRouter.sol";
import {TestSavingsVault} from "../../src/testnet/TestSavingsVault.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {HubFixture} from "./HubFixture.sol";

/// @title RouterFixture
/// @notice The hub fixture plus a savings router over two of its assets: AUSD into the Testnet
///         savings vault, whose shares take a `permit` and which earns a simulated rate, and USD
///         into a plain `MockVault`, whose shares take no `permit`. A saver key that starts with
///         nothing at all, no gas token included, and helpers that sign EIP-2612 permits with it.
abstract contract RouterFixture is HubFixture {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    SavingsRouter internal router;
    TestSavingsVault internal savings;
    MockVault internal plainVault;

    uint256 internal constant SAVER_KEY = 0x5A7E;
    address internal saver;

    /// @dev One EIP-2612 signature.
    struct Sig {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function setUp() public virtual override {
        super.setUp();
        savings = new TestSavingsVault(ausd, "Test AUSD Savings", "stAUSD");
        plainVault = new MockVault(usd);
        router = new SavingsRouter(pair(address(ausd), address(usd)), pair(address(savings), address(plainVault)));
        saver = vm.addr(SAVER_KEY);
    }

    function pair(address a, address b) internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }

    function one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    /*//////////////////////////////////////////////////////////////
                                SIGNATURES
    //////////////////////////////////////////////////////////////*/

    /// @dev `key`'s EIP-2612 permit on `token` for `spender` and `value`, at its current nonce.
    function signPermit(uint256 key, address token, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (Sig memory)
    {
        return signPermitFor(key, vm.addr(key), token, spender, value, deadline);
    }

    /// @dev The permit `owner` would sign, signed by `key` instead: when `key` is not the owner's,
    ///      a forgery that recovers to exactly `vm.addr(key)`.
    function signPermitFor(uint256 key, address owner, address token, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (Sig memory sig)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, IERC20Permit(token).nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(token).DOMAIN_SEPARATOR(), structHash));
        (sig.v, sig.r, sig.s) = vm.sign(key, digest);
    }

    /// @dev `key` signs a deposit of `amount` of `asset` and the relayer submits it.
    function depositSigned(uint256 key, address asset, uint256 amount) internal returns (uint256 shares) {
        uint256 deadline = block.timestamp + 1 hours;
        Sig memory sig = signPermit(key, asset, address(router), amount, deadline);
        vm.prank(relayer);
        return router.depositFor(vm.addr(key), asset, amount, deadline, sig.v, sig.r, sig.s);
    }

    /// @dev `key` signs a withdrawal of `amount` of `asset` burning at most `maxShares`, and the
    ///      relayer submits it.
    function withdrawSigned(uint256 key, address asset, uint256 amount, uint256 maxShares)
        internal
        returns (uint256 shares)
    {
        uint256 deadline = block.timestamp + 1 hours;
        Sig memory sig = signPermit(key, router.vaultFor(asset), address(router), maxShares, deadline);
        vm.prank(relayer);
        return router.withdrawFor(vm.addr(key), asset, amount, maxShares, deadline, sig.v, sig.r, sig.s);
    }

    /*//////////////////////////////////////////////////////////////
                                  CHECKS
    //////////////////////////////////////////////////////////////*/

    /// @dev The router holds no asset, no share and no allowance to any vault, on either route.
    function assertRouterEmpty() internal view {
        assertRouterEmpty(0, 0);
    }

    /// @dev As `assertRouterEmpty`, allowing for stray AUSD and USD someone sent it directly.
    function assertRouterEmpty(uint256 strayAusd, uint256 strayUsd) internal view {
        assertEq(ausd.balanceOf(address(router)), strayAusd, "router AUSD");
        assertEq(usd.balanceOf(address(router)), strayUsd, "router USD");
        assertEq(ausd.allowance(address(router), address(savings)), 0, "router AUSD allowance");
        assertEq(usd.allowance(address(router), address(plainVault)), 0, "router USD allowance");
        assertEq(IERC20(address(savings)).balanceOf(address(router)), 0, "router savings shares");
        assertEq(plainVault.balanceOf(address(router)), 0, "router plain shares");
    }
}
