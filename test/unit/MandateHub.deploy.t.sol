// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {MandateHub} from "../../src/MandateHub.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";

/// @title MandateHubDeployTest
/// @notice The constructor fixes the accepted assets and the EIP-712 domain, and nothing else.
contract MandateHubDeployTest is Test {
    TestStablecoin internal usd = new TestStablecoin("Test Dollar", "TUSD");
    TestStablecoin internal ausd = new TestStablecoin("Test Agora Dollar", "TAUSD");

    function _assets(address a, address b) internal pure returns (address[] memory assets) {
        assets = new address[](2);
        assets[0] = a;
        assets[1] = b;
    }

    function test_recordsAssetsInOrder() public {
        MandateHub hub = new MandateHub("Weir", "1", _assets(address(usd), address(ausd)));

        address[] memory assets = hub.acceptedAssets();
        assertEq(assets.length, 2);
        assertEq(assets[0], address(usd));
        assertEq(assets[1], address(ausd));
        assertTrue(hub.isAcceptedAsset(address(usd)));
        assertTrue(hub.isAcceptedAsset(address(ausd)));
        assertFalse(hub.isAcceptedAsset(address(0xBEEF)));
    }

    function test_startsAtMandateOne() public {
        MandateHub hub = new MandateHub("Weir", "1", _assets(address(usd), address(ausd)));
        assertEq(hub.nextMandateId(), 1);
    }

    function test_revertsOnNoAssets() public {
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.InvalidAsset.selector, address(0)));
        new MandateHub("Weir", "1", new address[](0));
    }

    function test_revertsOnZeroAsset() public {
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.InvalidAsset.selector, address(0)));
        new MandateHub("Weir", "1", _assets(address(usd), address(0)));
    }

    function test_revertsOnDuplicateAsset() public {
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.InvalidAsset.selector, address(usd)));
        new MandateHub("Weir", "1", _assets(address(usd), address(usd)));
    }

    function test_exposesEip712Domain() public {
        MandateHub hub = new MandateHub("Weir", "1", _assets(address(usd), address(ausd)));

        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) = hub.eip712Domain();
        assertEq(name, "Weir");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(hub));
    }

    function test_typeHashesMatchTheirStrings() public {
        MandateHub hub = new MandateHub("Weir", "1", _assets(address(usd), address(ausd)));

        string memory terms =
            "Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)";
        assertEq(hub.TERMS_TYPEHASH(), keccak256(bytes(terms)));
        assertEq(
            hub.MANDATE_TYPEHASH(),
            keccak256(bytes(string.concat("Mandate(address payer,Terms terms,uint256 nonce,uint256 deadline)", terms)))
        );
        assertEq(
            hub.ACTION_TYPEHASH(),
            keccak256("MandateAction(uint256 mandateId,uint8 action,uint256 nonce,uint256 deadline)")
        );
        assertEq(
            hub.SET_MANAGER_TYPEHASH(),
            keccak256("SetManager(uint256 mandateId,address manager,uint256 nonce,uint256 deadline)")
        );
    }
}
