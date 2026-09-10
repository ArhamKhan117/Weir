// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IMandateHub, ACTION_PAUSE} from "../../src/interfaces/IMandateHub.sol";
import {MockSmartWallet} from "../mocks/MockSmartWallet.sol";
import {FuzzTerms} from "./FuzzTerms.sol";

/// @title MandateHubSignedFuzzTest
/// @notice Signed entry points bind exactly what was signed, by exactly whom. For any valid key
///         and terms, a correct signature relayed by anyone creates one mandate paying from the
///         signer; replaying it reverts `NonceAlreadyUsed`; any other key reverts
///         `InvalidSignature`; a past deadline reverts `SignatureExpired`; and changing any single
///         signed field afterwards reverts `InvalidSignature`. The digests equal the ones forge
///         computes independently from JSON typed data, which pins the type strings and domain a
///         client must use.
contract MandateHubSignedFuzzTest is FuzzTerms {
    /// @dev One signed creation as submitted.
    struct Signed {
        uint256 key;
        address payer;
        IMandateHub.Terms terms;
        uint256 nonce;
        uint256 deadline;
    }

    string internal constant TERMS_TYPE = "[" '{"name":"merchant","type":"address"},{"name":"asset","type":"address"},'
        '{"name":"vault","type":"address"},' '{"name":"manager","type":"address"},{"name":"amount","type":"uint96"},'
        '{"name":"period","type":"uint32"},{"name":"startAt","type":"uint64"},'
        '{"name":"maxPerCharge","type":"uint96"},{"name":"maxTotal","type":"uint96"},'
        '{"name":"expiresAt","type":"uint64"},{"name":"ref","type":"bytes32"}' "]";

    string internal constant MANDATE_TYPE = "[" '{"name":"payer","type":"address"},{"name":"terms","type":"Terms"},'
        '{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}' "]";

    string internal constant ACTION_TYPE = "[" '{"name":"mandateId","type":"uint256"},{"name":"action","type":"uint8"},'
        '{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}' "]";

    string internal constant SET_MANAGER_TYPE = "["
        '{"name":"mandateId","type":"uint256"},{"name":"manager","type":"address"},'
        '{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}' "]";

    /*//////////////////////////////////////////////////////////////
                             SIGNED CREATION
    //////////////////////////////////////////////////////////////*/

    function testFuzz_createWithSigCreatesOneMandateForSigner(
        uint256 keySeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce,
        uint256 deadline
    ) public {
        Signed memory s = _signed(keySeed, raw, streaming, nonce, deadline);
        uint256 expectedId = hub.nextMandateId();

        uint256 id = _submit(s, _signature(s.key, s));

        assertEq(id, expectedId, "the next id");
        assertEq(hub.nextMandateId(), expectedId + 1, "exactly one mandate");
        _assertPaysFromSigner(id, s);
        assertTrue(hub.nonceUsed(s.payer, s.nonce), "nonce consumed");
    }

    function testFuzz_replayRevertsNonceAlreadyUsed(
        uint256 keySeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce,
        uint256 deadline
    ) public {
        Signed memory s = _signed(keySeed, raw, streaming, nonce, deadline);
        bytes memory signature = _signature(s.key, s);
        _submit(s, signature);
        uint256 next = hub.nextMandateId();

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NonceAlreadyUsed.selector, s.payer, s.nonce));
        _submit(s, signature);

        assertEq(hub.nextMandateId(), next, "the replay created nothing");
    }

    function testFuzz_usedNonceRefusesFreshlySignedTerms(
        uint256 keySeed,
        IMandateHub.Terms memory raw,
        uint256 nonce,
        uint256 deadline
    ) public {
        Signed memory s = _signed(keySeed, raw, false, nonce, deadline);
        _submit(s, _signature(s.key, s));

        // A new, correctly signed authorization for different terms cannot reuse the nonce.
        s.terms = _validStream(raw, s.payer);
        bytes memory signature = _signature(s.key, s);
        uint256 next = hub.nextMandateId();
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NonceAlreadyUsed.selector, s.payer, s.nonce));
        _submit(s, signature);

        assertEq(hub.nextMandateId(), next, "nothing created");
    }

    function testFuzz_noncesAreUnordered(uint256 keySeed, IMandateHub.Terms memory raw, uint256 low, uint256 high)
        public
    {
        low = bound(low, 0, type(uint256).max - 1);
        high = bound(high, low + 1, type(uint256).max);

        Signed memory s = _signed(keySeed, raw, false, high, type(uint256).max);
        uint256 first = _submit(s, _signature(s.key, s));
        s.nonce = low;
        uint256 second = _submit(s, _signature(s.key, s));

        assertEq(second, first + 1, "a lower nonce still works after a higher one");
        assertTrue(hub.nonceUsed(s.payer, low) && hub.nonceUsed(s.payer, high), "both consumed");
    }

    function testFuzz_otherKeyRevertsInvalidSignature(
        uint256 keySeed,
        uint256 otherSeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce,
        uint256 deadline
    ) public {
        Signed memory s = _signed(keySeed, raw, streaming, nonce, deadline);
        bytes memory signature = _signature(_otherKey(s.key, otherSeed), s);
        uint256 next = hub.nextMandateId();

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        _submit(s, signature);

        assertEq(hub.nextMandateId(), next, "nothing created");
        assertFalse(hub.nonceUsed(s.payer, s.nonce), "nonce left unused");
    }

    function testFuzz_pastDeadlineRevertsSignatureExpired(
        uint256 keySeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce,
        uint256 deadline
    ) public {
        Signed memory s = _signed(keySeed, raw, streaming, nonce, 0);
        s.deadline = bound(deadline, 0, block.timestamp - 1);
        bytes memory signature = _signature(s.key, s);
        uint256 next = hub.nextMandateId();

        vm.expectRevert(abi.encodeWithSelector(IMandateHub.SignatureExpired.selector, s.deadline, block.timestamp));
        _submit(s, signature);

        assertEq(hub.nextMandateId(), next, "nothing created");
        assertFalse(hub.nonceUsed(s.payer, s.nonce), "nonce left unused");
    }

    /// @dev Fields 0 to 9 are the terms but the vault in declaration order, then the nonce, the
    ///      deadline, the vault and the claimed payer. Each is replaced by a different value of
    ///      its own width.
    function testFuzz_changingAnySignedFieldRevertsInvalidSignature(
        uint256 keySeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce,
        uint256 deadline,
        uint256 field,
        uint256 delta
    ) public {
        Signed memory s = _signed(keySeed, raw, streaming, nonce, deadline);
        bytes memory signature = _signature(s.key, s);
        address signer = s.payer;
        uint256 signedNonce = s.nonce;
        uint256 next = hub.nextMandateId();

        _mutate(s, bound(field, 0, 13), delta);

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        _submit(s, signature);

        assertEq(hub.nextMandateId(), next, "nothing created");
        assertFalse(hub.nonceUsed(signer, signedNonce), "the signer's nonce left unused");
    }

    function testFuzz_smartWalletPayerCreatesWithOwnerSignature(
        uint256 ownerSeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce
    ) public {
        uint256 ownerKey = boundPrivateKey(ownerSeed);
        MockSmartWallet wallet = new MockSmartWallet(vm.addr(ownerKey));
        Signed memory s = Signed({
            key: ownerKey,
            payer: address(wallet),
            terms: _validTerms(raw, address(wallet), streaming),
            nonce: nonce,
            deadline: block.timestamp
        });

        uint256 id = _submit(s, _signature(ownerKey, s));

        _assertPaysFromSigner(id, s);
        assertTrue(hub.nonceUsed(address(wallet), nonce), "the wallet's nonce consumed");
    }

    function testFuzz_smartWalletPayerRejectsNonOwnerSignature(
        uint256 ownerSeed,
        uint256 otherSeed,
        IMandateHub.Terms memory raw,
        bool streaming,
        uint256 nonce
    ) public {
        uint256 ownerKey = boundPrivateKey(ownerSeed);
        MockSmartWallet wallet = new MockSmartWallet(vm.addr(ownerKey));
        Signed memory s = Signed({
            key: ownerKey,
            payer: address(wallet),
            terms: _validTerms(raw, address(wallet), streaming),
            nonce: nonce,
            deadline: block.timestamp
        });

        bytes memory signature = _signature(_otherKey(ownerKey, otherSeed), s);

        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        _submit(s, signature);
        assertFalse(hub.nonceUsed(address(wallet), nonce), "the wallet's nonce left unused");
    }

    /*//////////////////////////////////////////////////////////////
                          SIGNED LIFECYCLE CALLS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_actWithSigRejectsAnyKeyButTheNamedSigner(uint256 otherSeed, uint256 nonce, bool byManager)
        public
    {
        uint256 id = create(perSecond());
        uint256 key = byManager ? MANAGER_KEY : PAYER_KEY;
        address signer = byManager ? manager : payer;
        bytes memory signature = signAction(_otherKey(key, otherSeed), id, ACTION_PAUSE, nonce, block.timestamp);

        vm.prank(relayer);
        vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.actWithSig(id, ACTION_PAUSE, signer, nonce, block.timestamp, signature);

        assertEq(hub.getMandate(id).pausedAt, 0, "still running");
    }

    function testFuzz_actWithSigReplayRevertsNonceAlreadyUsed(uint256 nonce, bool byManager) public {
        uint256 id = create(perSecond());
        uint256 key = byManager ? MANAGER_KEY : PAYER_KEY;
        address signer = byManager ? manager : payer;
        bytes memory signature = signAction(key, id, ACTION_PAUSE, nonce, block.timestamp);

        vm.prank(relayer);
        hub.actWithSig(id, ACTION_PAUSE, signer, nonce, block.timestamp, signature);
        vm.prank(payer);
        hub.resumeMandate(id);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IMandateHub.NonceAlreadyUsed.selector, signer, nonce));
        hub.actWithSig(id, ACTION_PAUSE, signer, nonce, block.timestamp, signature);

        assertEq(hub.getMandate(id).pausedAt, 0, "the replayed pause did not happen");
    }

    function testFuzz_setManagerWithSigBindsThePayerKey(uint256 keySeed, address newManager, uint256 nonce) public {
        uint256 id = create(monthly());
        uint256 key = boundPrivateKey(keySeed);
        bytes memory signature = signSetManager(key, id, newManager, nonce, block.timestamp);

        vm.prank(relayer);
        if (key != PAYER_KEY) vm.expectRevert(IMandateHub.InvalidSignature.selector);
        hub.setManagerWithSig(id, newManager, nonce, block.timestamp, signature);

        assertEq(hub.getMandate(id).manager, key == PAYER_KEY ? newManager : manager, "only the payer's key rotates");
    }

    /*//////////////////////////////////////////////////////////////
                        DIGESTS AGAINST FORGE'S EIP-712
    //////////////////////////////////////////////////////////////*/

    function testFuzz_hashCreateMatchesTypedData(
        address forPayer,
        IMandateHub.Terms memory t,
        uint256 nonce,
        uint256 deadline
    ) public view {
        string memory message = string.concat(
            '{"payer":"',
            vm.toString(forPayer),
            '","terms":',
            _termsJson(t),
            ',"nonce":"',
            vm.toString(nonce),
            '","deadline":"',
            vm.toString(deadline),
            '"}'
        );
        string memory types = string.concat('"Mandate":', MANDATE_TYPE, ',"Terms":', TERMS_TYPE);

        assertEq(
            hub.hashCreate(forPayer, t, nonce, deadline),
            vm.eip712HashTypedData(_typedData(types, "Mandate", message)),
            "hashCreate is the EIP-712 digest of Mandate with nested Terms"
        );
    }

    function testFuzz_hashActionMatchesTypedData(uint256 id, uint8 action, uint256 nonce, uint256 deadline)
        public
        view
    {
        string memory message = string.concat(
            '{"mandateId":"',
            vm.toString(id),
            '","action":"',
            vm.toString(uint256(action)),
            '","nonce":"',
            vm.toString(nonce),
            '","deadline":"',
            vm.toString(deadline),
            '"}'
        );

        assertEq(
            hub.hashAction(id, action, nonce, deadline),
            vm.eip712HashTypedData(
                _typedData(string.concat('"MandateAction":', ACTION_TYPE), "MandateAction", message)
            ),
            "hashAction is the EIP-712 digest of MandateAction"
        );
    }

    function testFuzz_hashSetManagerMatchesTypedData(uint256 id, address newManager, uint256 nonce, uint256 deadline)
        public
        view
    {
        string memory message = string.concat(
            '{"mandateId":"',
            vm.toString(id),
            '","manager":"',
            vm.toString(newManager),
            '","nonce":"',
            vm.toString(nonce),
            '","deadline":"',
            vm.toString(deadline),
            '"}'
        );

        assertEq(
            hub.hashSetManager(id, newManager, nonce, deadline),
            vm.eip712HashTypedData(_typedData(string.concat('"SetManager":', SET_MANAGER_TYPE), "SetManager", message)),
            "hashSetManager is the EIP-712 digest of SetManager"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _signed(uint256 keySeed, IMandateHub.Terms memory raw, bool streaming, uint256 nonce, uint256 deadline)
        internal
        view
        returns (Signed memory s)
    {
        s.key = boundPrivateKey(keySeed);
        s.payer = vm.addr(s.key);
        s.terms = _validTerms(raw, s.payer, streaming);
        s.nonce = nonce;
        s.deadline = bound(deadline, block.timestamp, type(uint256).max);
    }

    function _signature(uint256 key, Signed memory s) internal view returns (bytes memory) {
        return sign(key, hub.hashCreate(s.payer, s.terms, s.nonce, s.deadline));
    }

    /// @dev Submitted by the relayer, who is never the payer.
    function _submit(Signed memory s, bytes memory signature) internal returns (uint256) {
        vm.prank(relayer);
        return hub.createMandateWithSig(s.payer, s.terms, s.nonce, s.deadline, signature);
    }

    /// @dev A valid private key other than `key`.
    function _otherKey(uint256 key, uint256 seed) internal pure returns (uint256 other) {
        other = boundPrivateKey(seed);
        if (other == key) other = key == 1 ? 2 : key - 1;
    }

    function _assertPaysFromSigner(uint256 id, Signed memory s) internal view {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        assertEq(m.payer, s.payer, "pays from the signer, not the relayer");
        assertEq(m.merchant, s.terms.merchant, "merchant");
        assertEq(m.asset, s.terms.asset, "asset");
        assertEq(m.vault, s.terms.vault, "vault");
        assertEq(m.manager, s.terms.manager, "manager");
        assertEq(m.amount, s.terms.amount, "amount");
        assertEq(m.period, s.terms.period, "period");
        assertEq(m.maxPerCharge, s.terms.maxPerCharge, "maxPerCharge");
        assertEq(m.maxTotal, s.terms.maxTotal, "maxTotal");
        assertEq(m.expiresAt, s.terms.expiresAt, "expiresAt");
    }

    function _mutate(Signed memory s, uint256 field, uint256 delta) internal view {
        IMandateHub.Terms memory t = s.terms;
        if (field == 0) t.merchant = _flip(t.merchant, delta);
        else if (field == 1) t.asset = _flip(t.asset, delta);
        else if (field == 2) t.manager = _flip(t.manager, delta);
        else if (field == 3) t.amount ^= uint96(bound(delta, 1, type(uint96).max));
        else if (field == 4) t.period ^= uint32(bound(delta, 1, type(uint32).max));
        else if (field == 5) t.startAt ^= uint64(bound(delta, 1, type(uint64).max));
        else if (field == 6) t.maxPerCharge ^= uint96(bound(delta, 1, type(uint96).max));
        else if (field == 7) t.maxTotal ^= uint96(bound(delta, 1, type(uint96).max));
        else if (field == 8) t.expiresAt ^= uint64(bound(delta, 1, type(uint64).max));
        else if (field == 9) t.ref ^= bytes32(bound(delta, 1, type(uint256).max));
        else if (field == 10) s.nonce ^= bound(delta, 1, type(uint256).max);
        else if (field == 11) s.deadline = _otherDeadline(s.deadline, delta);
        else if (field == 12) t.vault = _flip(t.vault, delta);
        else s.payer = _flip(s.payer, delta);
    }

    function _flip(address a, uint256 delta) internal pure returns (address) {
        return address(uint160(a) ^ uint160(bound(delta, 1, type(uint160).max)));
    }

    /// @dev A different deadline that has not passed, so the signature check is what fails.
    function _otherDeadline(uint256 deadline, uint256 delta) internal view returns (uint256 d) {
        d = bound(delta, block.timestamp, type(uint256).max);
        if (d == deadline) d = deadline == type(uint256).max ? deadline - 1 : deadline + 1;
    }

    function _termsJson(IMandateHub.Terms memory t) internal pure returns (string memory) {
        string memory head = string.concat(
            '{"merchant":"',
            vm.toString(t.merchant),
            '","asset":"',
            vm.toString(t.asset),
            '","vault":"',
            vm.toString(t.vault),
            '","manager":"',
            vm.toString(t.manager),
            '","amount":"',
            vm.toString(uint256(t.amount)),
            '","period":"',
            vm.toString(uint256(t.period))
        );
        string memory tail = string.concat(
            '","startAt":"',
            vm.toString(uint256(t.startAt)),
            '","maxPerCharge":"',
            vm.toString(uint256(t.maxPerCharge)),
            '","maxTotal":"',
            vm.toString(uint256(t.maxTotal)),
            '","expiresAt":"',
            vm.toString(uint256(t.expiresAt)),
            '","ref":"',
            vm.toString(t.ref),
            '"}'
        );
        return string.concat(head, tail);
    }

    /// @dev A full typed-data document whose domain is whatever `hub.eip712Domain()` reports.
    function _typedData(string memory types, string memory primaryType, string memory message)
        internal
        view
        returns (string memory)
    {
        (string memory domainType, string memory domain) = _domain();
        return string.concat(
            '{"types":{"EIP712Domain":',
            domainType,
            ",",
            types,
            '},"primaryType":"',
            primaryType,
            '","domain":',
            domain,
            ',"message":',
            message,
            "}"
        );
    }

    /// @dev The EIP-712 domain type and value, built field by field from the ERC-5267 bitmap.
    function _domain() internal view returns (string memory domainType, string memory domain) {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying, bytes32 salt,) =
            hub.eip712Domain();
        uint8 f = uint8(fields);
        string memory sep = "";
        if (f & 0x01 != 0) {
            domainType = string.concat(domainType, sep, '{"name":"name","type":"string"}');
            domain = string.concat(domain, sep, '"name":"', name, '"');
            sep = ",";
        }
        if (f & 0x02 != 0) {
            domainType = string.concat(domainType, sep, '{"name":"version","type":"string"}');
            domain = string.concat(domain, sep, '"version":"', version, '"');
            sep = ",";
        }
        if (f & 0x04 != 0) {
            domainType = string.concat(domainType, sep, '{"name":"chainId","type":"uint256"}');
            domain = string.concat(domain, sep, '"chainId":"', vm.toString(chainId), '"');
            sep = ",";
        }
        if (f & 0x08 != 0) {
            domainType = string.concat(domainType, sep, '{"name":"verifyingContract","type":"address"}');
            domain = string.concat(domain, sep, '"verifyingContract":"', vm.toString(verifying), '"');
            sep = ",";
        }
        if (f & 0x10 != 0) {
            domainType = string.concat(domainType, sep, '{"name":"salt","type":"bytes32"}');
            domain = string.concat(domain, sep, '"salt":"', vm.toString(salt), '"');
        }
        domainType = string.concat("[", domainType, "]");
        domain = string.concat("{", domain, "}");
    }
}
