// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub, ACTION_CANCEL, ACTION_PAUSE, ACTION_RESUME} from "../../src/interfaces/IMandateHub.sol";
import {MockSmartWallet} from "../mocks/MockSmartWallet.sol";
import {HubFixture} from "../helpers/HubFixture.sol";

/// @title MandateHubSignedTest
/// @notice The signed entry points, which let a payer who holds no gas token install and manage
///         mandates through anyone willing to submit: the signature is the whole authority, it
///         works once, before its deadline, for its exact contents.
contract MandateHubSignedTest is HubFixture {
    uint256 internal constant NONCE = 42;
    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        deadline = T0 + 1 hours;
    }

    /*//////////////////////////////////////////////////////////////
                                 CREATION
    //////////////////////////////////////////////////////////////*/

    function _createSigned(IMandateHub.Terms memory t) internal returns (uint256) {
        bytes memory sig = signCreate(PAYER_KEY, payer, t, NONCE, deadline);
        vm.prank(relayer);
        return hub.createMandateWithSig(payer, t, NONCE, deadline, sig);
    }

    function test_relayerInstallsForThePayer() public {
        uint256 id = _createSigned(monthly());

        assertEq(mandate(id).payer, payer);
        assertTrue(hub.nonceUsed(payer, NONCE));

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(usd.balanceOf(relayer), 0);
    }

    function test_signatureWorksOnce() public {
        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(PAYER_KEY, payer, t, NONCE, deadline);
        hub.createMandateWithSig(payer, t, NONCE, deadline, sig);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NonceAlreadyUsed.selector, payer, NONCE));
        hub.createMandateWithSig(payer, t, NONCE, deadline, sig);
    }

    function test_twoCheckoutsSignedAtOnceBothWork() public {
        IMandateHub.Terms memory a = monthly();
        IMandateHub.Terms memory b = perSecond();
        bytes memory sigA = signCreate(PAYER_KEY, payer, a, 1, deadline);
        bytes memory sigB = signCreate(PAYER_KEY, payer, b, 2, deadline);

        hub.createMandateWithSig(payer, b, 2, deadline, sigB);
        hub.createMandateWithSig(payer, a, 1, deadline, sigA);
        assertEq(hub.nextMandateId(), 3);
    }

    function test_expiredSignatureReverts() public {
        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(PAYER_KEY, payer, t, NONCE, deadline);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.SignatureExpired.selector, deadline, deadline + 1));
        hub.createMandateWithSig(payer, t, NONCE, deadline, sig);
    }

    function test_signatureByAnotherKeyReverts() public {
        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(STRANGER_KEY, payer, t, NONCE, deadline);

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.createMandateWithSig(payer, t, NONCE, deadline, sig);
    }

    function test_alteredTermsRevert() public {
        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(PAYER_KEY, payer, t, NONCE, deadline);
        t.merchant = stranger;

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.createMandateWithSig(payer, t, NONCE, deadline, sig);
    }

    function test_signatureCannotBeRedirectedToAnotherPayer() public {
        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(PAYER_KEY, payer, t, NONCE, deadline);

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.createMandateWithSig(stranger, t, NONCE, deadline, sig);
    }

    function test_invalidatedNonceVoidsTheSignature() public {
        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(PAYER_KEY, payer, t, NONCE, deadline);

        vm.expectEmit(address(hub));
        emit IMandateHub.NonceInvalidated(payer, NONCE);
        vm.prank(payer);
        hub.invalidateNonce(NONCE);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NonceAlreadyUsed.selector, payer, NONCE));
        hub.createMandateWithSig(payer, t, NONCE, deadline, sig);
    }

    function test_smartWalletInstallsThroughErc1271() public {
        MockSmartWallet wallet = new MockSmartWallet(payer);
        usd.mint(address(wallet), 100 * DOLLAR);
        vm.prank(payer);
        wallet.execute(address(usd), abi.encodeCall(usd.approve, (address(hub), 100 * DOLLAR)));

        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(PAYER_KEY, address(wallet), t, NONCE, deadline);
        uint256 id = hub.createMandateWithSig(address(wallet), t, NONCE, deadline, sig);

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
    }

    function test_permitThenSignedCreateNeedsNoGasFromThePayer() public {
        address fresh = vm.addr(0xF2E5);
        usd.mint(fresh, 50 * DOLLAR);

        bytes32 permitHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                fresh,
                address(hub),
                uint256(30 * DOLLAR),
                usd.nonces(fresh),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xF2E5, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), permitHash)));

        IMandateHub.Terms memory t = monthly();
        bytes memory sig = signCreate(0xF2E5, fresh, t, NONCE, deadline);

        vm.startPrank(relayer);
        usd.permit(fresh, address(hub), 30 * DOLLAR, deadline, v, r, s);
        uint256 id = hub.createMandateWithSig(fresh, t, NONCE, deadline, sig);
        vm.stopPrank();

        hub.charge(id);
        assertEq(usd.balanceOf(merchant), 10 * DOLLAR);
        assertEq(fresh.balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 ACTIONS
    //////////////////////////////////////////////////////////////*/

    function test_managerSignsACancel() public {
        uint256 id = create(monthly());
        bytes memory sig = signAction(MANAGER_KEY, id, ACTION_CANCEL, NONCE, deadline);

        vm.expectEmit(address(hub));
        emit IMandateHub.MandateCancelled(id, manager);
        vm.prank(relayer);
        hub.actWithSig(id, ACTION_CANCEL, manager, NONCE, deadline, sig);

        assertEq(uint8(mandate(id).status), uint8(IMandateHub.Status.Cancelled));
    }

    function test_managerSignsPauseAndResume() public {
        uint256 id = create(perSecond());

        hub.actWithSig(id, ACTION_PAUSE, manager, 1, deadline, signAction(MANAGER_KEY, id, ACTION_PAUSE, 1, deadline));
        assertEq(mandate(id).pausedAt, T0);

        vm.warp(T0 + 60);
        hub.actWithSig(id, ACTION_RESUME, manager, 2, deadline, signAction(MANAGER_KEY, id, ACTION_RESUME, 2, deadline));
        assertEq(mandate(id).pausedAt, 0);
    }

    function test_oldResumeCannotBeReplayedAfterAPause() public {
        uint256 id = create(perSecond());
        bytes memory resume = signAction(MANAGER_KEY, id, ACTION_RESUME, 2, deadline);

        hub.actWithSig(id, ACTION_PAUSE, manager, 1, deadline, signAction(MANAGER_KEY, id, ACTION_PAUSE, 1, deadline));
        hub.actWithSig(id, ACTION_RESUME, manager, 2, deadline, resume);
        hub.actWithSig(id, ACTION_PAUSE, manager, 3, deadline, signAction(MANAGER_KEY, id, ACTION_PAUSE, 3, deadline));

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NonceAlreadyUsed.selector, manager, 2));
        hub.actWithSig(id, ACTION_RESUME, manager, 2, deadline, resume);
    }

    function test_actionSignedForOneMandateCannotActOnAnother() public {
        uint256 a = create(monthly());
        uint256 b = create(monthly());
        bytes memory sig = signAction(PAYER_KEY, a, ACTION_CANCEL, NONCE, deadline);

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.actWithSig(b, ACTION_CANCEL, payer, NONCE, deadline, sig);
    }

    function test_strangerSignatureIsNotAuthorized() public {
        uint256 id = create(monthly());
        bytes memory sig = signAction(STRANGER_KEY, id, ACTION_CANCEL, NONCE, deadline);

        vm.expectRevert(IMandateHub.NotAuthorized.selector);
        hub.actWithSig(id, ACTION_CANCEL, stranger, NONCE, deadline, sig);
    }

    function test_unknownActionReverts() public {
        uint256 id = create(monthly());
        bytes memory sig = signAction(PAYER_KEY, id, 9, NONCE, deadline);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.InvalidAction.selector, 9));
        hub.actWithSig(id, 9, payer, NONCE, deadline, sig);
    }

    function test_expiredActionReverts() public {
        uint256 id = create(monthly());
        bytes memory sig = signAction(PAYER_KEY, id, ACTION_CANCEL, NONCE, deadline);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.SignatureExpired.selector, deadline, deadline + 1));
        hub.actWithSig(id, ACTION_CANCEL, payer, NONCE, deadline, sig);
    }

    /*//////////////////////////////////////////////////////////////
                                 MANAGER
    //////////////////////////////////////////////////////////////*/

    function test_payerSignsANewManager() public {
        uint256 id = create(perSecond());
        address next = makeAddr("next session key");
        bytes memory sig = signSetManager(PAYER_KEY, id, next, NONCE, deadline);

        vm.prank(relayer);
        hub.setManagerWithSig(id, next, NONCE, deadline, sig);
        assertEq(mandate(id).manager, next);
    }

    function test_managerCannotSignANewManager() public {
        uint256 id = create(perSecond());
        bytes memory sig = signSetManager(MANAGER_KEY, id, stranger, NONCE, deadline);

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.setManagerWithSig(id, stranger, NONCE, deadline, sig);
    }

    function test_setManagerWithSigOnUnknownMandateReverts() public {
        vm.expectRevert(IMandateHub.UnknownMandate.selector);
        hub.setManagerWithSig(99, stranger, NONCE, deadline, "");
    }
}
