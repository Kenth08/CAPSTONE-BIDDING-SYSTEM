// Every page stylesheet, loaded up front and in this order.
//
// Pages are downloaded separately (see App.jsx), but their styles share class names
// and main.jsx loads the shared styles after them so that those win. Left to the page
// imports, a page's stylesheet would come AFTER the shared ones and change how the
// app looks. A new page stylesheet belongs in this list too.
import './style/LandingPage.css'
import './style/category-docs.css'
import './components/NotificationBell.css'
import './components/Blockchain.css'
import './style/procurement-record.css'
import './style/packet-check.css'
import './style/PublicResultsPage.css'
import './style/record-detail.css'
import './style/AdminDashboard.css'
import './style/SupplierDashboard.css'
import './style/HeadDashboard.css'
import './style/LoginPage.css'
import './style/SupplierRegister.css'
import './components/PublicVerifier.css'
import './style/LegalPage.css'
