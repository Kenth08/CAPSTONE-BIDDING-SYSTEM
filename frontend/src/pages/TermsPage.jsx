import LegalPageLayout from '../components/LegalPageLayout'

export default function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service" updated="June 30, 2026">
      <div className="legal-section">
        <h2>1. Acceptance of Terms</h2>
        <p>By creating an account or using the E-Procurement Blockchain System ("the Platform") in any role — Admin, Head, or Supplier — you agree to be bound by these Terms of Service. If you do not agree, do not use the Platform.</p>
      </div>

      <div className="legal-section">
        <h2>2. Accounts</h2>
        <p>Admin and Head accounts represent a single institutional role each and are provisioned directly by the Platform operator. Supplier accounts are self-registered: you are responsible for the accuracy of the information and documents you submit, and for keeping your login credentials confidential.</p>
      </div>

      <div className="legal-section">
        <h2>3. Supplier Verification</h2>
        <p>A Supplier account must be verified by an Admin before it can submit bids. Verification is based on the business documents you upload at registration. Submitting false, falsified, or expired documents is grounds for rejection, revision requests, or disqualification from the bidding process.</p>
      </div>

      <div className="legal-section">
        <h2>4. Bidding Process</h2>
        <p>Procurements are only visible to Suppliers whose registered business types match the procurement's category. By submitting a bid you confirm the declarations presented at submission time, including the accuracy of the information provided and compliance with applicable Supply Chain Management (SCM) and procurement regulations (RA 9184).</p>
        <p>Bids must be submitted before the posted bid submission deadline. A procurement automatically closes to new or updated bids once its deadline passes; bids cannot be submitted or edited after that point.</p>
      </div>

      <div className="legal-section">
        <h2>5. Document Review and Corrections</h2>
        <p>The Admin may flag individual documents within your bid or registration as needing correction. A flagged document does not, by itself, remove you from a bidding process — you may resubmit the corrected document while the procurement remains open. A bid cannot be selected as a winner while any of its required documents remain flagged.</p>
      </div>

      <div className="legal-section">
        <h2>6. Prohibited Conduct</h2>
        <ul>
          <li>Submitting falsified, forged, or materially misleading documents.</li>
          <li>Attempting to access another Supplier's account, documents, or bid data.</li>
          <li>Coordinating bids with other Suppliers to manipulate the outcome of a procurement.</li>
          <li>Interfering with the operation or security of the Platform.</li>
        </ul>
      </div>

      <div className="legal-section">
        <h2>7. Suspension and Termination</h2>
        <p>The Admin may reject, suspend, or revoke a Supplier's qualification status for violating these Terms, submitting false information, or for conduct that compromises the integrity of the bidding process.</p>
      </div>

      <div className="legal-section">
        <h2>8. Limitation of Liability</h2>
        <p>The Platform is provided on an "as is" basis. While reasonable care is taken to keep procurement records, bid data, and award results accurate, the Platform operator is not liable for losses arising from reliance on Platform data, downtime, or third-party service interruptions.</p>
      </div>

      <div className="legal-section">
        <h2>9. Changes to These Terms</h2>
        <p>These Terms may be updated from time to time. Continued use of the Platform after a change is posted constitutes acceptance of the revised Terms.</p>
      </div>

      <div className="legal-section">
        <h2>10. Contact</h2>
        <p>Questions about these Terms can be directed to the Platform administrator through your account contact details on file.</p>
      </div>
    </LegalPageLayout>
  )
}
