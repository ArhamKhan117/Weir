// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver
/// @notice The interface a Chainlink CRE workflow delivers reports to, through its forwarder.
interface IReceiver is IERC165 {
    /// @param metadata The workflow id, name and owner, packed.
    /// @param report The workflow's payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
