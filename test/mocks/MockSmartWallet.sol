// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MockSmartWallet
/// @notice A contract account that accepts a digest when its single owner key signed it, the way
///         a smart wallet answers ERC-1271.
contract MockSmartWallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner ? IERC1271.isValidSignature.selector : bytes4(0);
    }

    /// @notice Lets the wallet act directly, the way its owner would through the wallet.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "MockSmartWallet: not owner");
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
