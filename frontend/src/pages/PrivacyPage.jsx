import LegalPageLayout from '../components/LegalPageLayout'

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy" updated="June 30, 2026">
      <div className="legal-section">
        <h2>1. Information We Collect</h2>
        <p>To register and operate a Supplier account, we collect: company and representative details, contact information, Tax Identification Number (TIN), business permits, financial statements, and other supporting documents required for verification. When you submit a bid, we additionally collect the bid amount, delivery timeline, and any technical or compliance documents you attach.</p>
      </div>

      <div className="legal-section">
        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>Verifying your eligibility to register as a Supplier and to bid on procurements in your registered business categories.</li>
          <li>Evaluating submitted bids and selecting a winning Supplier for each procurement.</li>
          <li>Notifying you about the status of your registration, your bids, and procurement results.</li>
          <li>Maintaining a record of the procurement process for accountability purposes.</li>
        </ul>
      </div>

      <div className="legal-section">
        <h2>3. What Becomes Public</h2>
        <p>In the interest of procurement transparency, the Platform's public results page shows: open procurements (title, category, budget, deadline), and — once a contract is awarded — the winning Supplier's company name and the award date. Your uploaded documents, bid amounts, and personal contact details are never shown on the public page.</p>
      </div>

      <div className="legal-section">
        <h2>4. Storage and Security</h2>
        <p>Uploaded documents are stored using access-controlled, encrypted-in-transit cloud storage. Account access is protected by password authentication and session tokens; passwords are never stored in plain text.</p>
      </div>

      <div className="legal-section">
        <h2>5. Data Retention</h2>
        <p>Registration and bidding records are retained for as long as your account is active and as needed to maintain an accurate procurement history. You may request account-related corrections through your profile settings or by contacting the Admin.</p>
      </div>

      <div className="legal-section">
        <h2>6. Your Rights</h2>
        <p>You can review and update your contact details and business information from your Supplier Settings page at any time. Changes to verified business information may be subject to Admin review where noted on that page.</p>
      </div>

      <div className="legal-section">
        <h2>7. Changes to This Policy</h2>
        <p>This Privacy Policy may be updated periodically to reflect changes in how the Platform handles data. The "Last updated" date above reflects the most recent revision.</p>
      </div>

      <div className="legal-section">
        <h2>8. Contact</h2>
        <p>Questions about this Privacy Policy can be directed to the Platform administrator through your account contact details on file.</p>
      </div>
    </LegalPageLayout>
  )
}
